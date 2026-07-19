// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouter} from "../AuxiloSplitRouter.sol";

interface IFiatTokenV2_2 {
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    // solhint-disable-next-line func-name-mixedcase
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function balanceOf(address account) external view returns (uint256);
    function version() external view returns (string memory);
}

/**
 * Fork tests against REAL Base mainnet USDC (FiatTokenV2_2 behind a
 * ZeppelinOS proxy). Skips gracefully (vm.skip) when the "base" RPC endpoint
 * (foundry.toml: https://mainnet.base.org) is unreachable.
 *
 * The EIP-712 digest is built from the token's OWN DOMAIN_SEPARATOR() — read
 * directly rather than reconstructed, so any chainId/salt domain semantics the
 * deployed token uses are honored by construction.
 */
contract AuxiloSplitRouterForkTest is Test {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 internal constant RECEIVE_TYPEHASH = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    bool internal forked;

    AuxiloSplitRouter internal router;
    IFiatTokenV2_2 internal usdc;

    uint256 internal buyerPk;
    address internal buyer;
    address internal feeWallet;
    address internal settler;
    address internal contributor;

    function setUp() public {
        try vm.createSelectFork("base") {
            forked = true;
        } catch {
            forked = false;
            return;
        }

        usdc = IFiatTokenV2_2(USDC);
        (buyer, buyerPk) = makeAddrAndKey("fork-buyer");
        feeWallet = makeAddr("fork-feeWallet");
        settler = makeAddr("fork-settler");
        contributor = makeAddr("fork-contributor");

        router = new AuxiloSplitRouter(USDC, feeWallet, settler);
        deal(USDC, buyer, 1_000e6);
    }

    function _signReceive(uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, buyer, address(router), value, uint256(0), type(uint256).max, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_Fork_RealUsdcExposesExpectedTypehash() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertEq(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            RECEIVE_TYPEHASH,
            "on-chain FiatTokenV2_2 receive typehash mismatch"
        );
        assertEq(keccak256(bytes(usdc.version())), keccak256(bytes("2")), "USDC EIP-712 version");
    }

    /// End-to-end: buyer signs ReceiveWithAuthorization over the DERIVED nonce
    /// against the real token; the settler settles; the split lands atomically.
    function test_Fork_ReceiveSettlement_EndToEnd() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("fork-happy-salt");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(value, nonce);

        assertEq(usdc.balanceOf(buyer), 1_000e6, "deal funded buyer");
        assertEq(usdc.balanceOf(contributor), 0);
        assertEq(usdc.balanceOf(feeWallet), 0);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, type(uint256).max, salt, sig, contributor, bps);

        assertEq(usdc.balanceOf(contributor), 70e6, "contributor got 70% direct from real USDC");
        assertEq(usdc.balanceOf(feeWallet), 30e6, "fee wallet got 30%");
        assertEq(usdc.balanceOf(buyer), 900e6, "buyer debited");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing");
    }

    /// SETTLER-COMPROMISE against the REAL token: same buyer signature, but the
    /// settler substitutes its own address as contributor (and, separately,
    /// tampered bps). The derived nonce changes, so FiatTokenV2_2's own
    /// signature verification must revert. This is the P1-1 property proven
    /// against production bytecode, not a mock.
    function test_Fork_SettlerCompromise_RevertsInRealUsdc() public {
        if (!forked) {
            vm.skip(true);
            return;
        }

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("fork-compromise-salt");
        bytes32 signedNonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(value, signedNonce);

        // (a) tampered contributor -> derived nonce differs -> real USDC rejects.
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, type(uint256).max, salt, sig, settler, bps);

        // (b) tampered bps -> same rejection.
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, type(uint256).max, salt, sig, contributor, 1);

        // Honest params still settle fine afterwards — nothing was consumed.
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, type(uint256).max, salt, sig, contributor, bps);
        assertEq(usdc.balanceOf(contributor), 70e6);
        assertEq(usdc.balanceOf(feeWallet), 30e6);
    }
}
