// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouterReceiveOnly} from "../AuxiloSplitRouterReceiveOnly.sol";
import {MockUSDCAuth} from "./MockUSDCAuth.sol";

// =====================================================================
// AuxiloSplitRouterReceiveOnly — audit suite (L2, branch-closers + named gaps)
//
// Receive-only variant: covers the false-return path of each require(transfer)
// (contributor leg, fee leg), blacklist atomic-revert (no partial debit, nonce
// not consumed → retriable), and EIP-1271 smart-account buyers (positive +
// negative). The Transfer/Stranded settler-compromise 100% KATs and the
// stranded-balance/skim-false tests are gone with those paths (skim-false lives
// in the .t.sol suite).
// =====================================================================

/// USDC variant that reverts on transfer() to a designated blacklisted address
/// (mirrors FiatTokenV2 blacklist: "Blacklistable: account is blacklisted").
contract BlacklistUSDCAuth is MockUSDCAuth {
    address public blacklisted;

    function setBlacklisted(address a) external {
        blacklisted = a;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        require(to != blacklisted, "Blacklistable: account is blacklisted");
        return super.transfer(to, value);
    }
}

/// USDC variant whose transfer() returns false (instead of reverting) to a
/// designated address — exercises the `require(...transfer(...))` FALSE branch.
contract FalseTransferUSDCAuth is MockUSDCAuth {
    address public failTo;

    function setFailTo(address a) external {
        failTo = a;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (to == failTo) return false; // silent failure — router's require must catch it
        return super.transfer(to, value);
    }
}

/// Minimal EIP-1271 smart-account wallet. isValidSignature returns the magic
/// value (0x1626ba7e) iff the digest matches a stored blob the test controls.
contract Minimal1271Wallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes32 public approvedHash;
    bool public approveAll;

    function approve(bytes32 h) external {
        approvedHash = h;
    }

    function setApproveAll(bool a) external {
        approveAll = a;
    }

    function isValidSignature(bytes32 hash, bytes calldata) external view returns (bytes4) {
        if (approveAll || hash == approvedHash) return MAGIC;
        return 0xffffffff;
    }
}

/// USDC variant that verifies signatures via EIP-1271 when `from` is a contract.
/// Mirrors FiatTokenV2_2's SignatureChecker.isValidSignatureNow behavior.
contract Eip1271USDCAuth is MockUSDCAuth {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external override {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");

        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", this.DOMAIN_SEPARATOR(), structHash));

        // from has code → EIP-1271 path.
        require(_isValid1271(from, digest, signature), "FiatTokenV2: invalid signature");

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _isValid1271(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, sig));
        return ok && ret.length == 32 && bytes4(ret) == MAGIC;
    }
}

contract AuxiloSplitRouterReceiveOnlyAuditTest is Test {
    MockUSDCAuth internal usdc;
    AuxiloSplitRouterReceiveOnly internal router;

    uint256 internal buyerPk;
    address internal buyer;
    address internal feeWallet;
    address internal settler;
    address internal contributor;

    uint256 internal constant FOREVER = type(uint256).max;

    event Settled(
        bytes32 indexed authNonce,
        address indexed buyer,
        address indexed contributor,
        uint256 grossValue,
        uint256 contributorAmount,
        uint256 feeAmount,
        uint8 path
    );

    function setUp() public {
        vm.warp(1_750_000_000);
        (buyer, buyerPk) = makeAddrAndKey("audit-buyer");
        feeWallet = makeAddr("audit-feeWallet");
        settler = makeAddr("audit-settler");
        contributor = makeAddr("audit-contributor");

        usdc = new MockUSDCAuth();
        router = new AuxiloSplitRouterReceiveOnly(address(usdc), feeWallet, settler);
        usdc.mint(buyer, 1_000_000e6);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------
    function _digest(bytes32 typehash, address from, address to, uint256 value, bytes32 nonce, address u)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, uint256(0), FOREVER, nonce));
        return keccak256(abi.encodePacked("\x19\x01", MockUSDCAuth(u).DOMAIN_SEPARATOR(), structHash));
    }

    function _signReceive(uint256 pk, address from, address to, uint256 value, bytes32 nonce, address u)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _digest(MockUSDCAuth(u).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, nonce, u));
        return abi.encodePacked(r, s, v);
    }

    // -----------------------------------------------------------------
    // False-return branches on the split legs (require(transfer(...)) == false)
    // -----------------------------------------------------------------
    function test_TransferReturnsFalse_Contributor_RevertsContribFailed() public {
        FalseTransferUSDCAuth ft = new FalseTransferUSDCAuth();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(ft), feeWallet, settler);
        ft.mint(buyer, 1_000_000e6);
        ft.setFailTo(contributor); // transfer to contributor returns false

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("ft-contrib");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(r), value, nonce, address(ft));

        vm.prank(settler);
        vm.expectRevert(bytes("contrib transfer failed"));
        r.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contributor, bps);
    }

    function test_TransferReturnsFalse_Fee_RevertsFeeFailed() public {
        FalseTransferUSDCAuth ft = new FalseTransferUSDCAuth();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(ft), feeWallet, settler);
        ft.mint(buyer, 1_000_000e6);
        ft.setFailTo(feeWallet); // transfer to feeWallet returns false

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("ft-fee");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(r), value, nonce, address(ft));

        vm.prank(settler);
        vm.expectRevert(bytes("fee transfer failed"));
        r.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contributor, bps);
    }

    // -----------------------------------------------------------------
    // Blacklist atomic-revert (no partial debit, nonce not consumed → retriable)
    // -----------------------------------------------------------------
    function test_Blacklist_FeeWallet_Bricks_AtomicRevert_NoPartialDebit() public {
        BlacklistUSDCAuth bl = new BlacklistUSDCAuth();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(bl), feeWallet, settler);
        bl.mint(buyer, 1_000_000e6);
        bl.setBlacklisted(feeWallet); // Circle freezes the fee wallet

        uint256 value = 100e6;
        uint256 bps = 7000; // fee leg (30%) to blacklisted wallet reverts
        bytes32 salt = keccak256("bl-fee");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(r), value, nonce, address(bl));

        uint256 buyerBefore = bl.balanceOf(buyer);

        vm.prank(settler);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        r.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contributor, bps);

        // No partial debit: buyer not charged, contributor got nothing, router
        // holds nothing, and the EIP-3009 nonce was NOT consumed → retriable.
        assertEq(bl.balanceOf(buyer), buyerBefore, "buyer NOT debited (atomic)");
        assertEq(bl.balanceOf(contributor), 0, "contributor got nothing");
        assertEq(bl.balanceOf(address(r)), 0, "router holds nothing");
        assertFalse(bl.authorizationState(buyer, nonce), "nonce not consumed, retriable later");
    }

    function test_Blacklist_Contributor_Bricks_AtomicRevert() public {
        BlacklistUSDCAuth bl = new BlacklistUSDCAuth();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(bl), feeWallet, settler);
        bl.mint(buyer, 1_000_000e6);
        bl.setBlacklisted(contributor);

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("bl-contrib");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(r), value, nonce, address(bl));

        uint256 buyerBefore = bl.balanceOf(buyer);

        vm.prank(settler);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        r.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contributor, bps);

        assertEq(bl.balanceOf(buyer), buyerBefore, "buyer NOT debited (atomic)");
        assertEq(bl.balanceOf(feeWallet), 0, "fee got nothing");
        assertFalse(bl.authorizationState(buyer, nonce), "nonce not consumed");
    }

    // -----------------------------------------------------------------
    // EIP-1271 smart-account buyer
    // -----------------------------------------------------------------
    function test_Eip1271_SmartAccountBuyer_Settles() public {
        Eip1271USDCAuth u = new Eip1271USDCAuth();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(u), feeWallet, settler);
        Minimal1271Wallet wallet = new Minimal1271Wallet();
        u.mint(address(wallet), 1_000e6);

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("1271-happy");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));

        // Compute the exact digest the USDC mock will build, and approve it.
        bytes32 structHash = keccak256(
            abi.encode(
                u.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), address(wallet), address(r), value, uint256(0), FOREVER, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", u.DOMAIN_SEPARATOR(), structHash));
        wallet.approve(digest);

        vm.expectEmit(true, true, true, true, address(r));
        emit Settled(nonce, address(wallet), contributor, value, 70e6, 30e6, 1);

        vm.prank(settler);
        r.settleAndSplitReceive(address(wallet), value, 0, FOREVER, salt, hex"deadbeef", contributor, bps);

        assertEq(u.balanceOf(contributor), 70e6, "1271 buyer settled: contributor 70%");
        assertEq(u.balanceOf(feeWallet), 30e6, "fee 30%");
        assertEq(u.balanceOf(address(wallet)), 900e6, "smart-account buyer debited");
        assertEq(u.balanceOf(address(r)), 0);
    }

    function test_Eip1271_SmartAccountBuyer_BadSig_Reverts() public {
        Eip1271USDCAuth u = new Eip1271USDCAuth();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(u), feeWallet, settler);
        Minimal1271Wallet wallet = new Minimal1271Wallet(); // approves nothing
        u.mint(address(wallet), 1_000e6);

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("1271-bad");

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        r.settleAndSplitReceive(address(wallet), value, 0, FOREVER, salt, hex"deadbeef", contributor, bps);
    }
}
