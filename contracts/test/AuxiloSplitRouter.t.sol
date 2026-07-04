// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouter} from "../AuxiloSplitRouter.sol";
import {MockUSDCAuth} from "./MockUSDCAuth.sol";

// ---------------------------------------------------------------------
// Auxiliary mocks
// ---------------------------------------------------------------------

/// Plain ERC20-ish token for the skim() happy path.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "bal");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/**
 * Malicious "USDC" that is ALSO the router's settler, so its re-entrant call
 * passes onlySettler and must be stopped by the nonReentrant guard itself.
 * Its transfer() re-enters the router function selected by `mode` and records
 * the low-level result for the test to assert on.
 */
contract EvilSettlerUSDC {
    AuxiloSplitRouter public router;
    uint8 public mode; // 1 = settleAndSplitReceive, 2 = settleAndSplitTransfer, 3 = splitStranded
    bool public reentered;
    bool public reentryOk;
    bytes public reentryData;

    function setRouter(AuxiloSplitRouter r) external {
        router = r;
    }

    function balanceOf(address) external pure returns (uint256) {
        return type(uint128).max; // keep splitStranded's balance check happy
    }

    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
    {}

    function transferWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata)
        external
    {}

    function transfer(address, uint256) external returns (bool) {
        if (!reentered) {
            reentered = true;
            bytes memory callData;
            if (mode == 1) {
                callData = abi.encodeCall(
                    AuxiloSplitRouter.settleAndSplitReceive,
                    (address(0xCAFE), 1, 0, type(uint256).max, bytes32(0), "", address(0xBEEF), 5000)
                );
            } else if (mode == 2) {
                callData = abi.encodeCall(
                    AuxiloSplitRouter.settleAndSplitTransfer,
                    (address(0xCAFE), 1, 0, type(uint256).max, bytes32(0), "", address(0xBEEF), 5000)
                );
            } else {
                callData = abi.encodeCall(
                    AuxiloSplitRouter.splitStranded, (bytes32(0), address(0xCAFE), address(0xBEEF), 1, 5000)
                );
            }
            (bool ok, bytes memory data) = address(router).call(callData);
            reentryOk = ok;
            reentryData = data;
        }
        return true;
    }

    /// Called by the test; msg.sender into the router is this contract (= settler).
    function attack(uint8 m) external {
        mode = m;
        reentered = false;
        router.settleAndSplitTransfer(
            address(0xCAFE), 100, 0, type(uint256).max, keccak256(abi.encode(m)), "", address(0xBEEF), 7000
        );
    }
}

/// Malicious non-USDC token whose transfer() re-enters skim() (permissionless),
/// exercising the nonReentrant guard on the skim path.
contract EvilSkimToken {
    AuxiloSplitRouter public router;
    mapping(address => uint256) public balanceOf;
    bool public reentered;
    bool public reentryOk;
    bytes public reentryData;

    function setRouter(AuxiloSplitRouter r) external {
        router = r;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (!reentered) {
            reentered = true;
            (bool ok, bytes memory data) = address(router).call(abi.encodeCall(AuxiloSplitRouter.skim, (address(this))));
            reentryOk = ok;
            reentryData = data;
        }
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

// ---------------------------------------------------------------------
// Unit suite
// ---------------------------------------------------------------------

contract AuxiloSplitRouterTest is Test {
    // Redeclared for expectEmit (must match AuxiloSplitRouter exactly).
    event Settled(
        bytes32 indexed authNonce,
        address indexed buyer,
        address indexed contributor,
        uint256 grossValue,
        uint256 contributorAmount,
        uint256 feeAmount,
        uint8 path
    );
    event Skimmed(address indexed token, uint256 amount);

    MockUSDCAuth internal usdc;
    AuxiloSplitRouter internal router;

    uint256 internal buyerPk;
    address internal buyer;
    address internal feeWallet;
    address internal settler;
    address internal contributor;
    address internal griefer;

    uint256 internal constant VALID_BEFORE_FOREVER = type(uint256).max;

    function setUp() public {
        vm.warp(1_750_000_000); // strict `block.timestamp > validAfter` with validAfter = 0

        (buyer, buyerPk) = makeAddrAndKey("buyer");
        feeWallet = makeAddr("feeWallet");
        settler = makeAddr("settler");
        contributor = makeAddr("contributor");
        griefer = makeAddr("griefer");

        usdc = new MockUSDCAuth();
        router = new AuxiloSplitRouter(address(usdc), feeWallet, settler);
        usdc.mint(buyer, 1_000_000e6);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _derivedNonce(address contributor_, uint256 bps, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(contributor_, bps, salt));
    }

    function _digest(bytes32 typehash, address from, address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, uint256(0), VALID_BEFORE_FOREVER, nonce));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function _signReceive(uint256 pk, address from, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _digest(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, address(router), value, nonce));
        return abi.encodePacked(r, s, v);
    }

    function _signTransfer(uint256 pk, address from, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _digest(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, address(router), value, nonce));
        return abi.encodePacked(r, s, v);
    }

    /// Happy-path receive settlement with a buyer-attested (derived) nonce.
    function _settleReceive(uint256 value, uint256 bps, bytes32 salt) internal returns (bytes32 nonce) {
        nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);
    }

    // ------------------------------------------------------------------
    // Mock fidelity (guards the guards)
    // ------------------------------------------------------------------

    function test_MockTypehashesMatchFiatTokenV2() public view {
        assertEq(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8,
            "receive typehash != published FiatTokenV2 value"
        );
        assertEq(
            usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267,
            "transfer typehash != published FiatTokenV2 value"
        );
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                block.chainid,
                address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expectedDomain, "domain separator mismatch");
    }

    function test_Mock_TimeWindowEnforced() public {
        bytes32 salt = keccak256("time-window");
        uint256 bps = 7000;
        bytes32 nonce = _derivedNonce(contributor, bps, salt);

        // validAfter == now: strict `>` per FiatTokenV2, so not yet valid.
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(router),
                uint256(100e6),
                block.timestamp,
                VALID_BEFORE_FOREVER,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        router.settleAndSplitReceive(
            buyer, 100e6, block.timestamp, VALID_BEFORE_FOREVER, salt, abi.encodePacked(r, s, v), contributor, bps
        );

        // validBefore == now: strict `<`, so expired.
        structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(router),
                uint256(100e6),
                uint256(0),
                block.timestamp,
                nonce
            )
        );
        (v, r, s) = vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        router.settleAndSplitReceive(
            buyer, 100e6, 0, block.timestamp, salt, abi.encodePacked(r, s, v), contributor, bps
        );
    }

    // ------------------------------------------------------------------
    // Split math
    // ------------------------------------------------------------------

    function test_SplitMath_7000Bps_WithRoundingDustToFee() public {
        // 1_000_001 * 7000 / 10000 = 700_000.7 -> 700_000; dust (0.7) rides the fee side.
        uint256 value = 1_000_001;
        _settleReceive(value, 7000, keccak256("salt-7000"));

        assertEq(usdc.balanceOf(contributor), 700_000, "contributor share");
        assertEq(usdc.balanceOf(feeWallet), 300_001, "fee share incl. dust");
        assertEq(usdc.balanceOf(address(router)), 0, "router must hold nothing");
        assertEq(usdc.balanceOf(contributor) + usdc.balanceOf(feeWallet), value, "conservation");
    }

    function test_SplitMath_6000Bps_WithRoundingDustToFee() public {
        // 3 * 6000 / 10000 = 1.8 -> 1; fee gets 2 (dust included).
        _settleReceive(3, 6000, keccak256("salt-6000-dust"));
        assertEq(usdc.balanceOf(contributor), 1);
        assertEq(usdc.balanceOf(feeWallet), 2);

        // Exact case: 10_000_000 * 6000 / 10000 = 6_000_000, no dust.
        _settleReceive(10_000_000, 6000, keccak256("salt-6000-exact"));
        assertEq(usdc.balanceOf(contributor), 1 + 6_000_000);
        assertEq(usdc.balanceOf(feeWallet), 2 + 4_000_000);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testFuzz_SplitMath(uint256 value, uint256 bps, bytes32 salt) public {
        value = bound(value, 1, 1e30);
        bps = bound(bps, 0, 10_000);

        usdc.mint(buyer, value); // ensure funded regardless of setUp balance
        uint256 contributorBefore = usdc.balanceOf(contributor);
        uint256 feeBefore = usdc.balanceOf(feeWallet);

        _settleReceive(value, bps, salt);

        uint256 expectContrib = (value * bps) / 10_000;
        assertEq(usdc.balanceOf(contributor) - contributorBefore, expectContrib, "contributor delta");
        assertEq(usdc.balanceOf(feeWallet) - feeBefore, value - expectContrib, "fee delta (dust to fee)");
        assertEq(usdc.balanceOf(address(router)), 0, "router drained");
    }

    function test_Bps0_AllToFee_AndBps10000_AllToContributor() public {
        _settleReceive(50e6, 0, keccak256("bps-0"));
        assertEq(usdc.balanceOf(contributor), 0);
        assertEq(usdc.balanceOf(feeWallet), 50e6);

        _settleReceive(50e6, 10_000, keccak256("bps-10000"));
        assertEq(usdc.balanceOf(contributor), 50e6);
        assertEq(usdc.balanceOf(feeWallet), 50e6); // unchanged
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // ------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------

    function test_OnlySettler_AllThreeSettlementFunctions() public {
        bytes32 salt = keccak256("only-settler");
        bytes32 nonce = _derivedNonce(contributor, 7000, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, 100e6, nonce);

        vm.startPrank(griefer);
        vm.expectRevert(AuxiloSplitRouter.NotSettler.selector);
        router.settleAndSplitReceive(buyer, 100e6, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, 7000);

        vm.expectRevert(AuxiloSplitRouter.NotSettler.selector);
        router.settleAndSplitTransfer(buyer, 100e6, 0, VALID_BEFORE_FOREVER, nonce, sig, contributor, 7000);

        vm.expectRevert(AuxiloSplitRouter.NotSettler.selector);
        router.splitStranded(nonce, buyer, contributor, 100e6, 7000);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Nonce-binding (P1-1) — the load-bearing suite
    // ------------------------------------------------------------------

    function test_NonceBinding_HappyPath_Receive() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-happy");
        bytes32 nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        vm.expectEmit(true, true, true, true, address(router));
        emit Settled(nonce, buyer, contributor, value, 70e6, 30e6, 1);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);

        assertEq(usdc.balanceOf(contributor), 70e6);
        assertEq(usdc.balanceOf(feeWallet), 30e6);
        assertEq(usdc.balanceOf(buyer), 1_000_000e6 - value);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertTrue(usdc.authorizationState(buyer, nonce), "nonce consumed on USDC");
    }

    /// SETTLER-COMPROMISE (a): settler swaps in its own address as contributor.
    /// The derived nonce changes, so USDC's own signature check must revert —
    /// the theft is unexpressible, not merely router-blocked.
    function test_NonceBinding_SettlerTampersContributor_RevertsInUsdcSigCheck() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-tamper-contributor");
        bytes32 signedNonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, settler, bps);

        // Nothing moved, nonce not consumed: the honest settle still works after.
        assertEq(usdc.balanceOf(settler), 0);
        assertFalse(usdc.authorizationState(buyer, signedNonce));
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);
        assertEq(usdc.balanceOf(contributor), 70e6);
    }

    /// SETTLER-COMPROMISE (b): settler inflates/deflates bps.
    function test_NonceBinding_SettlerTampersBps_RevertsInUsdcSigCheck() public {
        uint256 value = 100e6;
        bytes32 salt = keccak256("nb-tamper-bps");
        bytes32 signedNonce = _derivedNonce(contributor, 7000, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, 1); // 0.01% to contributor

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, 10_000);
    }

    /// SETTLER-COMPROMISE (c): tampered salt (any salt not signed by buyer).
    function test_NonceBinding_SettlerTampersSalt_RevertsInUsdcSigCheck() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 signedNonce = _derivedNonce(contributor, bps, keccak256("nb-salt-real"));
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(
            buyer, value, 0, VALID_BEFORE_FOREVER, keccak256("nb-salt-tampered"), sig, contributor, bps
        );
    }

    /// Replay: identical salt + params a second time = nonce reuse on USDC.
    function test_NonceBinding_Replay_RevertsNonceUsed() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-replay");
        bytes32 nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);
    }

    /// Front-run-proofness of Path A: a third party CANNOT submit the buyer's
    /// ReceiveWithAuthorization directly to USDC — the payee (router) must be
    /// msg.sender. This is the property the receive path's atomicity rests on.
    function test_ReceiveAuth_DirectSubmissionByThirdParty_RevertsNotPayee() public {
        uint256 value = 100e6;
        bytes32 nonce = _derivedNonce(contributor, 7000, keccak256("frontrun"));
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        vm.prank(griefer);
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(buyer, address(router), value, 0, VALID_BEFORE_FOREVER, nonce, sig);
    }

    // ------------------------------------------------------------------
    // Transfer path (standard x402) + stranded recovery
    // ------------------------------------------------------------------

    function test_TransferPath_HappyPath() public {
        uint256 value = 25e6;
        uint256 bps = 6000;
        bytes32 nonce = keccak256("x402-random-nonce-1");
        bytes memory sig = _signTransfer(buyerPk, buyer, value, nonce);

        vm.expectEmit(true, true, true, true, address(router));
        emit Settled(nonce, buyer, contributor, value, 15e6, 10e6, 2);

        vm.prank(settler);
        router.settleAndSplitTransfer(buyer, value, 0, VALID_BEFORE_FOREVER, nonce, sig, contributor, bps);

        assertEq(usdc.balanceOf(contributor), 15e6);
        assertEq(usdc.balanceOf(feeWallet), 10e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /// GRIEFING: third party submits the signed transferWithAuthorization
    /// directly to USDC. Funds land in the router unsplit; the normal settle
    /// path is dead (nonce consumed); splitStranded completes the intended split.
    function test_TransferPath_Griefing_ThenSplitStrandedRecovers() public {
        uint256 value = 40e6;
        uint256 bps = 7000;
        bytes32 nonce = keccak256("x402-griefed-nonce");
        bytes memory sig = _signTransfer(buyerPk, buyer, value, nonce);

        // Griefer submits the authorization directly to USDC.
        vm.prank(griefer);
        usdc.transferWithAuthorization(buyer, address(router), value, 0, VALID_BEFORE_FOREVER, nonce, sig);
        assertEq(usdc.balanceOf(address(router)), value, "funds stranded in router, unsplit");

        // Normal settlement now reverts: nonce already used on USDC.
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        router.settleAndSplitTransfer(buyer, value, 0, VALID_BEFORE_FOREVER, nonce, sig, contributor, bps);

        // Settler completes the intended split via recovery, path = 3.
        vm.expectEmit(true, true, true, true, address(router));
        emit Settled(nonce, buyer, contributor, value, 28e6, 12e6, 3);
        vm.prank(settler);
        router.splitStranded(nonce, buyer, contributor, value, bps);

        assertEq(usdc.balanceOf(contributor), 28e6);
        assertEq(usdc.balanceOf(feeWallet), 12e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_SplitStranded_InsufficientBalance_Reverts() public {
        // Router holds 10 USDC; trying to "recover" 11 must revert.
        bytes32 nonce = keccak256("stranded-nonce");
        bytes memory sig = _signTransfer(buyerPk, buyer, 10e6, nonce);
        vm.prank(griefer);
        usdc.transferWithAuthorization(buyer, address(router), 10e6, 0, VALID_BEFORE_FOREVER, nonce, sig);

        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouter.InsufficientStranded.selector);
        router.splitStranded(nonce, buyer, contributor, 10e6 + 1, 7000);

        // Exact-balance recovery succeeds.
        vm.prank(settler);
        router.splitStranded(nonce, buyer, contributor, 10e6, 7000);
        assertEq(usdc.balanceOf(contributor), 7e6);
        assertEq(usdc.balanceOf(feeWallet), 3e6);
    }

    // ------------------------------------------------------------------
    // skim
    // ------------------------------------------------------------------

    function test_Skim_NonUsdcToken_SweptToFeeWallet_EmitsSkimmed() public {
        MockERC20 stray = new MockERC20();
        stray.mint(address(router), 123e18);

        vm.expectEmit(true, true, true, true, address(router));
        emit Skimmed(address(stray), 123e18);

        vm.prank(griefer); // permissionless: anyone may trigger, funds go only to feeWallet
        router.skim(address(stray));

        assertEq(stray.balanceOf(feeWallet), 123e18);
        assertEq(stray.balanceOf(address(router)), 0);
    }

    function test_Skim_ZeroBalance_NoTransferNoEvent() public {
        MockERC20 stray = new MockERC20();
        vm.recordLogs();
        router.skim(address(stray));
        assertEq(vm.getRecordedLogs().length, 0, "no Skimmed event on zero balance");
    }

    /// Stranded USDC can never be swept to the fee wallet — only exit is a split.
    function test_Skim_Usdc_RevertsUsdcNotSkimmable() public {
        // Strand real USDC in the router first.
        bytes32 nonce = keccak256("skim-usdc-strand");
        bytes memory sig = _signTransfer(buyerPk, buyer, 5e6, nonce);
        vm.prank(griefer);
        usdc.transferWithAuthorization(buyer, address(router), 5e6, 0, VALID_BEFORE_FOREVER, nonce, sig);
        assertEq(usdc.balanceOf(address(router)), 5e6);

        vm.expectRevert(AuxiloSplitRouter.UsdcNotSkimmable.selector);
        router.skim(address(usdc));
        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouter.UsdcNotSkimmable.selector);
        router.skim(address(usdc)); // not even the settler
    }

    // ------------------------------------------------------------------
    // Zero / edge params
    // ------------------------------------------------------------------

    function test_Validate_ZeroContributor_AllPaths() public {
        vm.startPrank(settler);
        vm.expectRevert(AuxiloSplitRouter.ZeroContributor.selector);
        router.settleAndSplitReceive(buyer, 1e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", address(0), 7000);
        vm.expectRevert(AuxiloSplitRouter.ZeroContributor.selector);
        router.settleAndSplitTransfer(buyer, 1e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", address(0), 7000);
        vm.expectRevert(AuxiloSplitRouter.ZeroContributor.selector);
        router.splitStranded(bytes32(0), buyer, address(0), 1e6, 7000);
        vm.stopPrank();
    }

    function test_Validate_BpsTooHigh_AllPaths() public {
        vm.startPrank(settler);
        vm.expectRevert(AuxiloSplitRouter.BpsTooHigh.selector);
        router.settleAndSplitReceive(buyer, 1e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 10_001);
        vm.expectRevert(AuxiloSplitRouter.BpsTooHigh.selector);
        router.settleAndSplitTransfer(buyer, 1e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 10_001);
        vm.expectRevert(AuxiloSplitRouter.BpsTooHigh.selector);
        router.splitStranded(bytes32(0), buyer, contributor, 1e6, 10_001);
        vm.stopPrank();
    }

    function test_Validate_ZeroValue_AllPaths() public {
        vm.startPrank(settler);
        vm.expectRevert(AuxiloSplitRouter.ZeroValue.selector);
        router.settleAndSplitReceive(buyer, 0, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 7000);
        vm.expectRevert(AuxiloSplitRouter.ZeroValue.selector);
        router.settleAndSplitTransfer(buyer, 0, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 7000);
        vm.expectRevert(AuxiloSplitRouter.ZeroValue.selector);
        router.splitStranded(bytes32(0), buyer, contributor, 0, 7000);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    function test_Constructor_ZeroAddressReverts_EachParam() public {
        vm.expectRevert(bytes("zero addr"));
        new AuxiloSplitRouter(address(0), feeWallet, settler);
        vm.expectRevert(bytes("zero addr"));
        new AuxiloSplitRouter(address(usdc), address(0), settler);
        vm.expectRevert(bytes("zero addr"));
        new AuxiloSplitRouter(address(usdc), feeWallet, address(0));
    }

    function test_Constructor_ImmutablesSet() public view {
        assertEq(address(router.usdc()), address(usdc));
        assertEq(router.feeWallet(), feeWallet);
        assertEq(router.settler(), settler);
    }

    // ------------------------------------------------------------------
    // Reentrancy
    // ------------------------------------------------------------------

    function _deployEvilRouter() internal returns (EvilSettlerUSDC evil, AuxiloSplitRouter evilRouter) {
        evil = new EvilSettlerUSDC();
        // The evil token is BOTH the usdc and the settler, so its re-entrant
        // call passes onlySettler and the nonReentrant guard must be what stops it.
        evilRouter = new AuxiloSplitRouter(address(evil), feeWallet, address(evil));
        evil.setRouter(evilRouter);
    }

    function test_Reentrancy_SettleAndSplitReceive_Blocked() public {
        (EvilSettlerUSDC evil,) = _deployEvilRouter();
        evil.attack(1);
        assertTrue(evil.reentered(), "re-entry attempted");
        assertFalse(evil.reentryOk(), "re-entry must revert");
        assertEq(bytes4(evil.reentryData()), AuxiloSplitRouter.Reentrancy.selector, "reverted with Reentrancy");
    }

    function test_Reentrancy_SettleAndSplitTransfer_Blocked() public {
        (EvilSettlerUSDC evil,) = _deployEvilRouter();
        evil.attack(2);
        assertTrue(evil.reentered());
        assertFalse(evil.reentryOk());
        assertEq(bytes4(evil.reentryData()), AuxiloSplitRouter.Reentrancy.selector);
    }

    function test_Reentrancy_SplitStranded_Blocked() public {
        (EvilSettlerUSDC evil,) = _deployEvilRouter();
        evil.attack(3);
        assertTrue(evil.reentered());
        assertFalse(evil.reentryOk());
        assertEq(bytes4(evil.reentryData()), AuxiloSplitRouter.Reentrancy.selector);
    }

    function test_Reentrancy_Skim_Blocked() public {
        EvilSkimToken evilToken = new EvilSkimToken();
        evilToken.setRouter(router);
        evilToken.mint(address(router), 1e18);

        router.skim(address(evilToken)); // outer skim succeeds; inner re-entry must not

        assertTrue(evilToken.reentered());
        assertFalse(evilToken.reentryOk());
        assertEq(bytes4(evilToken.reentryData()), AuxiloSplitRouter.Reentrancy.selector);
        assertEq(evilToken.balanceOf(feeWallet), 1e18, "outer skim still completed");
    }
}
