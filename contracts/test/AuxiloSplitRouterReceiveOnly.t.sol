// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouterReceiveOnly} from "../AuxiloSplitRouterReceiveOnly.sol";
import {MockUSDCAuth} from "./MockUSDCAuth.sol";

// =====================================================================
// AuxiloSplitRouterReceiveOnly — unit + fuzz suite (L2/L3)
//
// RECEIVE-ONLY MVP variant. There is exactly ONE settlement path
// (settleAndSplitReceive), so every settlement is buyer-attested via the derived
// nonce. There is no Transfer path and no splitStranded — the settler-diversion
// surface is structurally absent. These tests cover: split math + fuzz,
// nonce-binding (P5), access control, reentrancy (incl. hook token), skim (incl.
// USDC-excluded + false-return), constructor/validate edges, and the B5 identity
// guard (contributor != feeWallet / != address(this)) which is now ENFORCED.
// =====================================================================

/// Plain non-USDC token for the skim happy path.
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

/// A plain ERC-20 whose transfer() returns false, for the skim() "skim failed" path.
contract FalseSkimToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false; // always fails → router's require(..., "skim failed") reverts
    }
}

/// Malicious ERC-20 whose transfer() re-enters settleAndSplitReceive. This is the
/// "USDC upgraded to add a transfer hook" threat (A1). The token IS the settler,
/// so the re-entrant call clears onlySettler and the ONLY thing that can stop it
/// is the nonReentrant guard. The OUTER call is the Receive path (no-op
/// receiveWithAuthorization then the split's transfer() fires the hook).
contract HookReentrantReceiveUSDC {
    AuxiloSplitRouterReceiveOnly public router;
    bool public reentered;
    bool public reentryOk;
    bytes4 public reentryError;

    function setRouter(AuxiloSplitRouterReceiveOnly r) external {
        router = r;
    }

    function balanceOf(address) external pure returns (uint256) {
        return type(uint128).max;
    }

    // EIP-3009 surface — no-op; the router calls transfer() next (the hook).
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata) external {}

    function transfer(address, uint256) external returns (bool) {
        if (!reentered) {
            reentered = true;
            bytes memory cd = abi.encodeCall(
                AuxiloSplitRouterReceiveOnly.settleAndSplitReceive,
                (address(0xB0B), 1, 0, type(uint256).max, bytes32(0), "", address(0xC0FFEE), 5000)
            );
            (bool ok, bytes memory data) = address(router).call(cd);
            reentryOk = ok;
            reentryError = data.length >= 4 ? bytes4(data) : bytes4(0);
        }
        return true;
    }

    /// Drives an outer Receive settlement; msg.sender into the router is this
    /// contract (= settler). The empty-sig no-op receiveWithAuthorization pulls
    /// nothing but returns, then the split's transfer() re-enters.
    function fire() external {
        reentered = false;
        router.settleAndSplitReceive(
            address(0xB0B), 100, 0, type(uint256).max, keccak256("hook"), "", address(0xC0FFEE), 7000
        );
    }
}

/// Malicious non-USDC token that re-enters skim() from its transfer hook.
contract EvilSkimToken {
    AuxiloSplitRouterReceiveOnly public router;
    mapping(address => uint256) public balanceOf;
    bool public reentered;
    bool public reentryOk;
    bytes public reentryData;

    function setRouter(AuxiloSplitRouterReceiveOnly r) external {
        router = r;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (!reentered) {
            reentered = true;
            (bool ok, bytes memory data) =
                address(router).call(abi.encodeCall(AuxiloSplitRouterReceiveOnly.skim, (address(this))));
            reentryOk = ok;
            reentryData = data;
        }
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract AuxiloSplitRouterReceiveOnlyTest is Test {
    MockUSDCAuth internal usdc;
    AuxiloSplitRouterReceiveOnly internal router;

    uint256 internal buyerPk;
    address internal buyer;
    address internal feeWallet;
    address internal settler;
    address internal contributor;

    uint256 internal constant VALID_BEFORE_FOREVER = type(uint256).max;

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

    function setUp() public {
        vm.warp(1_750_000_000); // strict `block.timestamp > validAfter` with validAfter = 0

        (buyer, buyerPk) = makeAddrAndKey("buyer");
        feeWallet = makeAddr("feeWallet");
        settler = makeAddr("settler");
        contributor = makeAddr("contributor");

        usdc = new MockUSDCAuth();
        router = new AuxiloSplitRouterReceiveOnly(address(usdc), feeWallet, settler);
        usdc.mint(buyer, 1_000_000e6);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------
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

    /// Happy-path receive settlement with a buyer-attested (derived) nonce.
    function _settleReceive(uint256 value, uint256 bps, bytes32 salt) internal returns (bytes32 nonce) {
        nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);
    }

    // -----------------------------------------------------------------
    // Mock fidelity — guard the guards
    // -----------------------------------------------------------------
    function test_MockTypehashesMatchFiatTokenV2() public view {
        assertEq(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8,
            "receive typehash != FiatTokenV2"
        );
        assertEq(
            usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267,
            "transfer typehash != FiatTokenV2"
        );
    }

    function test_Mock_TimeWindowEnforced() public {
        uint256 value = 10e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("time");
        bytes32 nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        // not yet valid: validAfter in the future
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is not yet valid"));
        router.settleAndSplitReceive(buyer, value, block.timestamp + 1, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);

        // expired: validBefore in the past
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        router.settleAndSplitReceive(buyer, value, 0, block.timestamp - 1, salt, sig, contributor, bps);
    }

    // -----------------------------------------------------------------
    // Split math + fuzz
    // -----------------------------------------------------------------
    function test_SplitMath_7000Bps_WithRoundingDustToFee() public {
        // value chosen so value*7000/1e4 is not integral → dust to fee side.
        uint256 value = 100_000_003; // *0.7 = 70000002.1 → floor 70000002; fee = 30000001
        _settleReceive(value, 7000, keccak256("m7000"));
        assertEq(usdc.balanceOf(contributor), 70_000_002);
        assertEq(usdc.balanceOf(feeWallet), value - 70_000_002);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_SplitMath_6000Bps_WithRoundingDustToFee() public {
        uint256 value = 100_000_007;
        uint256 expectedContrib = (value * 6000) / 10_000;
        _settleReceive(value, 6000, keccak256("m6000"));
        assertEq(usdc.balanceOf(contributor), expectedContrib);
        assertEq(usdc.balanceOf(feeWallet), value - expectedContrib);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testFuzz_SplitMath(uint256 value, uint256 bps, bytes32 salt) public {
        value = bound(value, 1, 1_000_000e6);
        bps = bound(bps, 0, 10_000);
        uint256 expectedContrib = (value * bps) / 10_000;
        uint256 expectedFee = value - expectedContrib;

        _settleReceive(value, bps, salt);

        assertEq(usdc.balanceOf(contributor), expectedContrib);
        assertEq(usdc.balanceOf(feeWallet), expectedFee);
        assertEq(usdc.balanceOf(address(router)), 0, "no wei retained");
        assertEq(expectedContrib + expectedFee, value, "conservation");
    }

    function test_Bps0_AllToFee_AndBps10000_AllToContributor() public {
        uint256 value = 100e6;
        _settleReceive(value, 0, keccak256("bps0"));
        assertEq(usdc.balanceOf(contributor), 0);
        assertEq(usdc.balanceOf(feeWallet), value);

        // fresh actors for the 10000 case (avoid nonce reuse & balance bleed)
        uint256 value2 = 50e6;
        _settleReceive(value2, 10_000, keccak256("bps10000"));
        assertEq(usdc.balanceOf(contributor), value2);
        assertEq(usdc.balanceOf(feeWallet), value); // unchanged from bps0 leg
    }

    // -----------------------------------------------------------------
    // Nonce-binding (P5) — buyer-attested split
    // -----------------------------------------------------------------
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
    }

    function test_NonceBinding_SettlerTampersContributor_RevertsInUsdcSigCheck() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-tamper-contributor");
        bytes32 signedNonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        // Settler names a DIFFERENT honest-looking contributor → derived nonce differs.
        address other = makeAddr("other-contributor");
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, other, bps);

        // Nothing moved, nonce not consumed: the honest settle still works after.
        assertEq(usdc.balanceOf(other), 0);
        assertFalse(usdc.authorizationState(buyer, signedNonce));
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);
        assertEq(usdc.balanceOf(contributor), 70e6);
    }

    function test_NonceBinding_SettlerTampersBps_RevertsInUsdcSigCheck() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-tamper-bps");
        bytes32 signedNonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, 9000);
    }

    function test_NonceBinding_SettlerTampersSalt_RevertsInUsdcSigCheck() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-tamper-salt");
        bytes32 signedNonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, keccak256("different-salt"), sig, contributor, bps);
    }

    function test_NonceBinding_Replay_RevertsNonceUsed() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("nb-replay");
        bytes32 nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);

        // second submission of the same authorization reverts (nonce consumed)
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, contributor, bps);
    }

    function test_ReceiveAuth_DirectSubmissionByThirdParty_RevertsNotPayee() public {
        // Front-run-proofness: a third party cannot submit the receive auth
        // directly to USDC because to != msg.sender.
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("frontrun");
        bytes32 nonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        address thirdParty = makeAddr("thirdParty");
        vm.prank(thirdParty);
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(buyer, address(router), value, 0, VALID_BEFORE_FOREVER, nonce, sig);
    }

    // Contrast KAT: settler-compromise on the ONLY path extracts EXACTLY 0.
    function test_KAT_SettlerCompromise_ReceivePath_MaxExtractable_ZERO() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("kat-receive-evil");
        bytes32 signedNonce = _derivedNonce(contributor, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, signedNonce);

        // Settler tries to redirect ALL value to an arbitrary attacker address at
        // bps=10000. The derived nonce != the signed nonce → USDC rejects.
        address attacker = makeAddr("attacker");
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, attacker, 10_000);

        assertEq(usdc.balanceOf(attacker), 0, "MAX EXTRACTABLE on the only path = 0 (theft unexpressible)");
        // The whole tx reverted, so nothing at all moved and the nonce is retriable.
        assertFalse(usdc.authorizationState(buyer, signedNonce));
    }

    // -----------------------------------------------------------------
    // B5 identity guard — NOW ENFORCED (contributor != feeWallet / != self)
    // -----------------------------------------------------------------
    function test_B5_ContributorEqualsFeeWallet_Reverts() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("b5-fee");
        // Sign against the derived nonce that names feeWallet as contributor, so
        // the revert is proven to be the router's own guard, not the USDC sig
        // check (i.e. even a buyer who attests contributor==feeWallet is blocked).
        bytes32 nonce = _derivedNonce(feeWallet, bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.BadContributor.selector);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, feeWallet, bps);
    }

    function test_B5_ContributorEqualsRouter_Reverts() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("b5-self");
        bytes32 nonce = _derivedNonce(address(router), bps, salt);
        bytes memory sig = _signReceive(buyerPk, buyer, value, nonce);

        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.BadContributor.selector);
        router.settleAndSplitReceive(buyer, value, 0, VALID_BEFORE_FOREVER, salt, sig, address(router), bps);
    }

    // -----------------------------------------------------------------
    // Access control
    // -----------------------------------------------------------------
    function test_OnlySettler_SettleReverts() public {
        address notSettler = makeAddr("notSettler");
        vm.prank(notSettler);
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.NotSettler.selector);
        router.settleAndSplitReceive(buyer, 100e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 7000);
    }

    // -----------------------------------------------------------------
    // Validate edges
    // -----------------------------------------------------------------
    function test_Validate_ZeroContributor_Reverts() public {
        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.ZeroContributor.selector);
        router.settleAndSplitReceive(buyer, 100e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", address(0), 7000);
    }

    function test_Validate_BpsTooHigh_Reverts() public {
        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.BpsTooHigh.selector);
        router.settleAndSplitReceive(buyer, 100e6, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 10_001);
    }

    function test_Validate_ZeroValue_Reverts() public {
        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.ZeroValue.selector);
        router.settleAndSplitReceive(buyer, 0, 0, VALID_BEFORE_FOREVER, bytes32(0), "", contributor, 7000);
    }

    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------
    function test_Constructor_ZeroAddressReverts_EachParam() public {
        vm.expectRevert(bytes("zero addr"));
        new AuxiloSplitRouterReceiveOnly(address(0), feeWallet, settler);
        vm.expectRevert(bytes("zero addr"));
        new AuxiloSplitRouterReceiveOnly(address(usdc), address(0), settler);
        vm.expectRevert(bytes("zero addr"));
        new AuxiloSplitRouterReceiveOnly(address(usdc), feeWallet, address(0));
    }

    function test_Constructor_ImmutablesSet() public view {
        assertEq(address(router.usdc()), address(usdc));
        assertEq(router.feeWallet(), feeWallet);
        assertEq(router.settler(), settler);
    }

    // -----------------------------------------------------------------
    // Reentrancy
    // -----------------------------------------------------------------
    function test_Reentrancy_SettleAndSplitReceive_Blocked() public {
        HookReentrantReceiveUSDC evil = new HookReentrantReceiveUSDC();
        AuxiloSplitRouterReceiveOnly r = new AuxiloSplitRouterReceiveOnly(address(evil), feeWallet, address(evil));
        evil.setRouter(r);

        evil.fire(); // outer receive settle; the split's transfer() re-enters

        assertTrue(evil.reentered(), "hook fired");
        assertFalse(evil.reentryOk(), "re-entry must be blocked");
        assertEq(evil.reentryError(), AuxiloSplitRouterReceiveOnly.Reentrancy.selector, "guard reverted with Reentrancy");
    }

    function test_Reentrancy_Skim_Blocked() public {
        EvilSkimToken evilToken = new EvilSkimToken();
        evilToken.setRouter(router);
        evilToken.mint(address(router), 1e18);

        router.skim(address(evilToken)); // outer skim succeeds; inner re-entry must not

        assertTrue(evilToken.reentered());
        assertFalse(evilToken.reentryOk());
        assertEq(bytes4(evilToken.reentryData()), AuxiloSplitRouterReceiveOnly.Reentrancy.selector);
        assertEq(evilToken.balanceOf(feeWallet), 1e18, "outer skim still completed");
    }

    // -----------------------------------------------------------------
    // Skim
    // -----------------------------------------------------------------
    function test_Skim_NonUsdcToken_SweptToFeeWallet_EmitsSkimmed() public {
        MockERC20 stray = new MockERC20();
        stray.mint(address(router), 500e18);

        vm.expectEmit(true, true, true, true, address(router));
        emit Skimmed(address(stray), 500e18);
        router.skim(address(stray));

        assertEq(stray.balanceOf(feeWallet), 500e18);
        assertEq(stray.balanceOf(address(router)), 0);
    }

    function test_Skim_ZeroBalance_NoTransferNoEvent() public {
        MockERC20 stray = new MockERC20();
        // no mint → zero balance; skim is a no-op, emits nothing.
        router.skim(address(stray));
        assertEq(stray.balanceOf(feeWallet), 0);
    }

    function test_Skim_Usdc_RevertsUsdcNotSkimmable() public {
        vm.expectRevert(AuxiloSplitRouterReceiveOnly.UsdcNotSkimmable.selector);
        router.skim(address(usdc));
    }

    function test_Skim_TransferReturnsFalse_RevertsSkimFailed() public {
        FalseSkimToken bad = new FalseSkimToken();
        bad.mint(address(router), 1e18);
        vm.expectRevert(bytes("skim failed"));
        router.skim(address(bad));
    }
}
