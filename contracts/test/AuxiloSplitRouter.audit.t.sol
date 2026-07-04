// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouter} from "../AuxiloSplitRouter.sol";
import {MockUSDCAuth} from "./MockUSDCAuth.sol";

// =====================================================================
// AuxiloSplitRouter — AUDIT test suite
//
// Closes the audit's named-missing tests and the 3 uncovered branches
// (all three are the `false`-return path of a `require(token.transfer(...))`:
// line 237 skim, line 263 contributor, line 266 fee). Every one is reached
// here with a mock USDC that fails/reverts a specific transfer leg.
//
// Contents:
//   1. Settler-compromise KAT — EXACT max-extractable-value on Transfer and
//      Stranded (settler names attacker as contributor, bps=10000 → 100% of
//      value). Numbers asserted precisely so the accepted risk is on record.
//   2. Transfer-hook reentrancy — a malicious ERC-20 whose transfer() re-enters
//      each settlement fn; asserts the nonReentrant guard reverts (guards the
//      A1 "USDC could be upgraded to add a hook" assumption).
//   3. splitStranded balanceOf < value branch (explicit KAT).
//   4. Blacklist-of-feeWallet brick — mock USDC that reverts transfers to a
//      frozen feeWallet → asserts atomic revert, no partial debit (covers the
//      fee-leg require-false / revert path, line 266).
//   5. Contributor-leg failure — parallel brick on the contributor leg
//      (covers line 263), incl. a transfer-returns-false variant.
//   6. skim transfer-returns-false (covers line 237 "skim failed").
//   7. F8-tie — a saltless Transfer-path settle still splits to the intended
//      contributor (Transfer path never bound split params to a nonce; the
//      contributor named by the settler is where funds go, deterministically).
//   8. EIP-1271 smart-account buyer — a minimal 1271 wallet returning the magic
//      value drives settleAndSplitReceive; asserts it settles. (Header claims
//      1271 support; only ECDSA was unit-tested before this.)
// =====================================================================

// ---------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------

/// USDC variant that reverts on transfer() to a designated blacklisted address
/// (mirrors FiatTokenV2 blacklist: `transfer` reverts "Blacklistable: account is blacklisted").
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
/// designated address — exercises the `require(...transfer(...))` FALSE branch
/// specifically, distinct from a revert.
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

/// Malicious ERC-20 whose transfer() re-enters a chosen router settlement fn.
/// This is the "USDC upgraded to add a transfer hook" threat (A1). The token is
/// ALSO the settler, so the re-entrant call clears onlySettler and the ONLY
/// thing that can stop it is the nonReentrant guard.
contract HookReentrantUSDC {
    AuxiloSplitRouter public router;
    uint8 public mode; // 1=receive, 2=transfer, 3=stranded
    bool public reentered;
    bool public reentryOk;
    bytes4 public reentryError;

    function setRouter(AuxiloSplitRouter r) external {
        router = r;
    }

    function balanceOf(address) external pure returns (uint256) {
        return type(uint128).max;
    }

    // EIP-3009 surface — no-ops; the router calls transfer() next, which is where the hook fires.
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata) external {}
    function transferWithAuthorization(address, address, uint256, uint256, uint256, bytes32, bytes calldata) external {}

    function transfer(address, uint256) external returns (bool) {
        if (!reentered) {
            reentered = true;
            bytes memory cd;
            if (mode == 1) {
                cd = abi.encodeCall(
                    AuxiloSplitRouter.settleAndSplitReceive,
                    (address(0xB0B), 1, 0, type(uint256).max, bytes32(0), "", address(0xC0FFEE), 5000)
                );
            } else if (mode == 2) {
                cd = abi.encodeCall(
                    AuxiloSplitRouter.settleAndSplitTransfer,
                    (address(0xB0B), 1, 0, type(uint256).max, bytes32(0), "", address(0xC0FFEE), 5000)
                );
            } else {
                cd = abi.encodeCall(
                    AuxiloSplitRouter.splitStranded, (bytes32(0), address(0xB0B), address(0xC0FFEE), 1, 5000)
                );
            }
            (bool ok, bytes memory data) = address(router).call(cd);
            reentryOk = ok;
            reentryError = data.length >= 4 ? bytes4(data) : bytes4(0);
        }
        return true;
    }

    /// Drives an outer settlement; msg.sender into the router is this contract (= settler).
    function fire(uint8 m) external {
        mode = m;
        reentered = false;
        // outer call uses the Transfer path so the split reaches transfer() (the hook).
        router.settleAndSplitTransfer(
            address(0xB0B), 100, 0, type(uint256).max, keccak256(abi.encode("hook", m)), "", address(0xC0FFEE), 7000
        );
    }
}

/// Minimal EIP-1271 smart-account wallet. isValidSignature returns the magic
/// value (0x1626ba7e) iff the provided `signature` matches a stored blob the
/// test controls. Models an agent smart-account buyer.
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
/// Mirrors FiatTokenV2_2's SignatureChecker.isValidSignatureNow behavior: if the
/// signer has code, call isValidSignature(digest, sig) and require the magic value.
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
        (bool ok, bytes memory ret) =
            signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, sig));
        return ok && ret.length == 32 && bytes4(ret) == MAGIC;
    }

    // Base MockUSDCAuth caches the domain separator with the base name/version.
    // We reuse RECEIVE_WITH_AUTHORIZATION_TYPEHASH / DOMAIN_SEPARATOR from base.
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

contract AuxiloSplitRouterAuditTest is Test {
    event Settled(
        bytes32 indexed authNonce,
        address indexed buyer,
        address indexed contributor,
        uint256 grossValue,
        uint256 contributorAmount,
        uint256 feeAmount,
        uint8 path
    );

    MockUSDCAuth internal usdc;
    AuxiloSplitRouter internal router;

    uint256 internal buyerPk;
    address internal buyer;
    address internal feeWallet;
    address internal settler;
    address internal contributor;
    address internal attacker;
    address internal griefer;

    uint256 internal constant FOREVER = type(uint256).max;

    function setUp() public {
        vm.warp(1_750_000_000);
        (buyer, buyerPk) = makeAddrAndKey("audit-buyer");
        feeWallet = makeAddr("audit-feeWallet");
        settler = makeAddr("audit-settler");
        contributor = makeAddr("audit-contributor");
        attacker = makeAddr("audit-attacker");
        griefer = makeAddr("audit-griefer");

        usdc = new MockUSDCAuth();
        router = new AuxiloSplitRouter(address(usdc), feeWallet, settler);
        usdc.mint(buyer, 1_000_000e6);
    }

    // ---- signing helpers -------------------------------------------------

    /// @dev `to` is the router that actually receives the pull (may not be the
    /// shared `router` — the blacklist/false-transfer/1271 tests deploy their own).
    function _digest(bytes32 typehash, address from, address to, uint256 value, bytes32 nonce, address u)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, uint256(0), FOREVER, nonce));
        return keccak256(abi.encodePacked("\x19\x01", MockUSDCAuth(u).DOMAIN_SEPARATOR(), structHash));
    }

    function _signTransfer(uint256 pk, address from, address to, uint256 value, bytes32 nonce, address u)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, _digest(MockUSDCAuth(u).TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, nonce, u));
        return abi.encodePacked(r, s, v);
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

    // =====================================================================
    // 1. SETTLER-COMPROMISE KAT — exact maximum extractable value
    // =====================================================================

    /// Transfer path: the settler names the attacker as contributor at bps=10000.
    /// The Transfer path CANNOT bind split params to a buyer-signed nonce (generic
    /// x402 clients pick random nonces), so this is expressible. Asserts the EXACT
    /// max extractable value = 100% of value to an attacker-chosen address.
    /// This is on-record accepted residual risk (settler key = theft vector).
    function test_KAT_SettlerCompromise_TransferPath_MaxExtractable_100pct() public {
        uint256 value = 100e6;
        bytes32 nonce = keccak256("kat-transfer-evil");
        // Buyer signs a normal transfer authorization to the router (as any x402 client would).
        bytes memory sig = _signTransfer(buyerPk, buyer, address(router), value, nonce, address(usdc));

        // Compromised settler: contributor = attacker, bps = 10000 (100%).
        vm.expectEmit(true, true, true, true, address(router));
        emit Settled(nonce, buyer, attacker, value, value, 0, 2); // contributorAmount == value, fee == 0

        vm.prank(settler);
        router.settleAndSplitTransfer(buyer, value, 0, FOREVER, nonce, sig, attacker, 10_000);

        // EXACT max extractable value: the attacker receives 100% of `value`.
        assertEq(usdc.balanceOf(attacker), value, "MAX EXTRACTABLE = 100% of value to attacker-chosen address");
        assertEq(usdc.balanceOf(feeWallet), 0, "fee wallet gets nothing when bps=10000");
        assertEq(usdc.balanceOf(address(router)), 0, "router drained");
        // Nothing constrains the destination on the Transfer path — this is the documented settler theft vector.
    }

    /// Stranded path: the same maximum. Funds already stranded in the router; a
    /// compromised settler completes a "split" that sends 100% to the attacker.
    function test_KAT_SettlerCompromise_Stranded_MaxExtractable_100pct() public {
        uint256 value = 250e6;
        bytes32 nonce = keccak256("kat-stranded-evil");
        bytes memory sig = _signTransfer(buyerPk, buyer, address(router), value, nonce, address(usdc));

        // Griefer strands funds in router (the vector splitStranded exists to recover).
        vm.prank(griefer);
        usdc.transferWithAuthorization(buyer, address(router), value, 0, FOREVER, nonce, sig);
        assertEq(usdc.balanceOf(address(router)), value);

        // Compromised settler recovers to attacker at 100%.
        vm.expectEmit(true, true, true, true, address(router));
        emit Settled(nonce, buyer, attacker, value, value, 0, 3);
        vm.prank(settler);
        router.splitStranded(nonce, buyer, attacker, value, 10_000);

        assertEq(usdc.balanceOf(attacker), value, "MAX EXTRACTABLE on stranded = 100% of value");
        assertEq(usdc.balanceOf(feeWallet), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    /// Receive path CONTRAST: the same attack is UNEXPRESSIBLE. The derived nonce
    /// binds (contributor,bps,salt); substituting the attacker changes the nonce
    /// and USDC's signature check reverts. Max extractable on Receive path = 0.
    function test_KAT_SettlerCompromise_ReceivePath_MaxExtractable_ZERO() public {
        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("kat-receive-evil");
        bytes32 signedNonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(router), value, signedNonce, address(usdc));

        // Settler tries to redirect to attacker: derived nonce != signed nonce → USDC rejects.
        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, attacker, 10_000);

        assertEq(usdc.balanceOf(attacker), 0, "MAX EXTRACTABLE on receive path = 0 (theft unexpressible)");
    }

    // =====================================================================
    // 2. TRANSFER-HOOK REENTRANCY (A1 assumption guard)
    // =====================================================================

    function _deployHookRouter() internal returns (HookReentrantUSDC evil, AuxiloSplitRouter evilRouter) {
        evil = new HookReentrantUSDC();
        evilRouter = new AuxiloSplitRouter(address(evil), feeWallet, address(evil)); // token == settler
        evil.setRouter(evilRouter);
    }

    function test_Hook_Reentrancy_Receive_Blocked() public {
        (HookReentrantUSDC evil,) = _deployHookRouter();
        evil.fire(1);
        assertTrue(evil.reentered(), "hook fired");
        assertFalse(evil.reentryOk(), "re-entry must be blocked");
        assertEq(evil.reentryError(), AuxiloSplitRouter.Reentrancy.selector, "guard reverted with Reentrancy");
    }

    function test_Hook_Reentrancy_Transfer_Blocked() public {
        (HookReentrantUSDC evil,) = _deployHookRouter();
        evil.fire(2);
        assertTrue(evil.reentered());
        assertFalse(evil.reentryOk());
        assertEq(evil.reentryError(), AuxiloSplitRouter.Reentrancy.selector);
    }

    function test_Hook_Reentrancy_Stranded_Blocked() public {
        (HookReentrantUSDC evil,) = _deployHookRouter();
        evil.fire(3);
        assertTrue(evil.reentered());
        assertFalse(evil.reentryOk());
        assertEq(evil.reentryError(), AuxiloSplitRouter.Reentrancy.selector);
    }

    // =====================================================================
    // 3. splitStranded balanceOf < value branch (explicit KAT)
    // =====================================================================

    function test_SplitStranded_BalanceLtValue_RevertsInsufficient() public {
        // Router holds nothing; any splitStranded with value>0 must revert Insufficient.
        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouter.InsufficientStranded.selector);
        router.splitStranded(keccak256("empty"), buyer, contributor, 1, 7000);

        // Strand 5 USDC, then ask to recover 6 → balanceOf(5) < value(6) → revert.
        bytes32 nonce = keccak256("strand-5");
        bytes memory sig = _signTransfer(buyerPk, buyer, address(router), 5e6, nonce, address(usdc));
        vm.prank(griefer);
        usdc.transferWithAuthorization(buyer, address(router), 5e6, 0, FOREVER, nonce, sig);

        vm.prank(settler);
        vm.expectRevert(AuxiloSplitRouter.InsufficientStranded.selector);
        router.splitStranded(nonce, buyer, contributor, 6e6, 7000);

        // No partial state change: funds still fully in router.
        assertEq(usdc.balanceOf(address(router)), 5e6, "no partial debit on insufficient revert");
    }

    // =====================================================================
    // 4. BLACKLIST-OF-FEEWALLET BRICK — atomic revert, no partial debit
    //    (covers line 266 fee-transfer failure)
    // =====================================================================

    function test_Blacklist_FeeWallet_Bricks_AtomicRevert_NoPartialDebit() public {
        BlacklistUSDCAuth bl = new BlacklistUSDCAuth();
        AuxiloSplitRouter r = new AuxiloSplitRouter(address(bl), feeWallet, settler);
        bl.mint(buyer, 1_000_000e6);
        bl.setBlacklisted(feeWallet); // Circle freezes the fee wallet

        uint256 value = 100e6;
        uint256 bps = 7000; // contributor 70, fee 30 → fee leg to blacklisted wallet reverts
        bytes32 salt = keccak256("bl-fee");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(r), value, nonce, address(bl));

        uint256 buyerBefore = bl.balanceOf(buyer);

        // Fee leg reverts INSIDE the settlement → whole tx reverts atomically.
        vm.prank(settler);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        r.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contributor, bps);

        // No partial debit: buyer not charged, contributor got nothing, router holds nothing,
        // and the EIP-3009 nonce was NOT consumed (the whole USDC call reverted).
        assertEq(bl.balanceOf(buyer), buyerBefore, "buyer NOT debited (atomic)");
        assertEq(bl.balanceOf(contributor), 0, "contributor got nothing");
        assertEq(bl.balanceOf(address(r)), 0, "router holds nothing");
        assertFalse(bl.authorizationState(buyer, nonce), "nonce not consumed, retriable later");
    }

    // =====================================================================
    // 5. CONTRIBUTOR-LEG FAILURE (covers line 263)
    // =====================================================================

    function test_Blacklist_Contributor_Bricks_AtomicRevert() public {
        BlacklistUSDCAuth bl = new BlacklistUSDCAuth();
        AuxiloSplitRouter r = new AuxiloSplitRouter(address(bl), feeWallet, settler);
        bl.mint(buyer, 1_000_000e6);
        bl.setBlacklisted(contributor);

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("bl-contrib");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));
        bytes memory sig = _signReceive(buyerPk, buyer, address(r), value, nonce, address(bl));

        vm.prank(settler);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        r.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contributor, bps);

        assertEq(bl.balanceOf(contributor), 0);
        assertEq(bl.balanceOf(feeWallet), 0);
        assertEq(bl.balanceOf(address(r)), 0);
    }

    /// The require(..., "contrib transfer failed") FALSE branch specifically:
    /// transfer returns false (not revert). Covers line 263 false path.
    function test_TransferReturnsFalse_Contributor_RevertsContribFailed() public {
        FalseTransferUSDCAuth ft = new FalseTransferUSDCAuth();
        AuxiloSplitRouter r = new AuxiloSplitRouter(address(ft), feeWallet, settler);
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

    /// The require(..., "fee transfer failed") FALSE branch specifically. Covers line 266 false path.
    function test_TransferReturnsFalse_Fee_RevertsFeeFailed() public {
        FalseTransferUSDCAuth ft = new FalseTransferUSDCAuth();
        AuxiloSplitRouter r = new AuxiloSplitRouter(address(ft), feeWallet, settler);
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

    // =====================================================================
    // 6. skim() transfer-returns-false (covers line 237 "skim failed")
    // =====================================================================

    function test_Skim_TransferReturnsFalse_RevertsSkimFailed() public {
        FalseSkimToken tok = new FalseSkimToken();
        tok.mint(address(router), 42e18);

        vm.expectRevert(bytes("skim failed"));
        router.skim(address(tok));
    }

    // =====================================================================
    // 7. F8-TIE — saltless Transfer still splits to the intended contributor
    // =====================================================================

    /// The Transfer path never binds split params into a nonce. F8 tie: even with
    /// a "saltless" (arbitrary, non-derived) nonce, the settle still deterministically
    /// splits to the contributor the settler names. This documents that on the
    /// Transfer path, "intended contributor" == "settler-named contributor" — the
    /// server truth is what routes funds, and it routes them correctly for the honest case.
    function test_F8Tie_SaltlessTransfer_StillSplitsToIntendedContributor() public {
        uint256 value = 80e6;
        uint256 bps = 6000;
        // Arbitrary nonce with no salt-derivation whatsoever (a generic x402 random nonce).
        bytes32 nonce = keccak256("plain-random-nonce-no-salt");
        bytes memory sig = _signTransfer(buyerPk, buyer, address(router), value, nonce, address(usdc));

        vm.expectEmit(true, true, true, true, address(router));
        emit Settled(nonce, buyer, contributor, value, 48e6, 32e6, 2);

        vm.prank(settler);
        router.settleAndSplitTransfer(buyer, value, 0, FOREVER, nonce, sig, contributor, bps);

        assertEq(usdc.balanceOf(contributor), 48e6, "intended contributor received 60%");
        assertEq(usdc.balanceOf(feeWallet), 32e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    // =====================================================================
    // 8. EIP-1271 SMART-ACCOUNT BUYER
    // =====================================================================

    /// A contract wallet (agent smart account) is the buyer. USDC verifies via
    /// EIP-1271. settleAndSplitReceive must settle when the wallet returns the
    /// magic value. Header claims 1271 support; this proves it on the receive path.
    function test_Eip1271_SmartAccountBuyer_Settles() public {
        Eip1271USDCAuth u = new Eip1271USDCAuth();
        AuxiloSplitRouter r = new AuxiloSplitRouter(address(u), feeWallet, settler);
        Minimal1271Wallet wallet = new Minimal1271Wallet();
        u.mint(address(wallet), 1_000e6);

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("1271-happy");
        bytes32 nonce = keccak256(abi.encode(contributor, bps, salt));

        // Compute the exact digest the USDC mock will build, and approve it on the wallet.
        bytes32 structHash = keccak256(
            abi.encode(u.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), address(wallet), address(r), value, uint256(0), FOREVER, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", u.DOMAIN_SEPARATOR(), structHash));
        wallet.approve(digest);

        vm.expectEmit(true, true, true, true, address(r));
        emit Settled(nonce, address(wallet), contributor, value, 70e6, 30e6, 1);

        vm.prank(settler);
        // signature blob is opaque to a 1271 wallet; the wallet validates the digest.
        r.settleAndSplitReceive(address(wallet), value, 0, FOREVER, salt, hex"deadbeef", contributor, bps);

        assertEq(u.balanceOf(contributor), 70e6, "1271 buyer settled: contributor 70%");
        assertEq(u.balanceOf(feeWallet), 30e6, "fee 30%");
        assertEq(u.balanceOf(address(wallet)), 900e6, "smart-account buyer debited");
        assertEq(u.balanceOf(address(r)), 0);
    }

    /// Negative: a 1271 wallet that does NOT approve the digest → settle reverts.
    function test_Eip1271_SmartAccountBuyer_BadSig_Reverts() public {
        Eip1271USDCAuth u = new Eip1271USDCAuth();
        AuxiloSplitRouter r = new AuxiloSplitRouter(address(u), feeWallet, settler);
        Minimal1271Wallet wallet = new Minimal1271Wallet(); // approves nothing
        u.mint(address(wallet), 1_000e6);

        uint256 value = 100e6;
        uint256 bps = 7000;
        bytes32 salt = keccak256("1271-bad"); // wallet never approves the derived digest

        vm.prank(settler);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        r.settleAndSplitReceive(address(wallet), value, 0, FOREVER, salt, hex"deadbeef", contributor, bps);
    }
}
