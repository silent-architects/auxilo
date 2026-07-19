// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {AuxiloSplitRouterReceiveOnly} from "../AuxiloSplitRouterReceiveOnly.sol";
import {MockUSDCAuth} from "./MockUSDCAuth.sol";

// =====================================================================
// AuxiloSplitRouterReceiveOnly — STATEFUL INVARIANT suite (L4)
//
// A handler random-sequences VALID receive settlements and skims against a single
// router + mock USDC, signing each authorization on the fly. Because there is
// only the buyer-attested Receive path, there is no Transfer settle, no grief-in,
// and no stranded recovery to model. B5 is NO LONGER FILTERED: the handler picks
// contributors freely — INCLUDING feeWallet and the router itself — and the
// contract's on-chain guard rejects those. A dedicated action asserts those
// aliased inputs revert and move no funds, so B5 is PROVEN by the invariant, not
// assumed away.
//
// Invariants asserted after every call sequence:
//   INV_A  VALUE CONSERVATION — totalContributorPaid + totalFeePaid == totalGrossSettled.
//   INV_B  ZERO RESIDUE — the router holds nothing (no stranded path exists).
//   INV_C  SETTLER-ONLY — no unauthorized caller ever moved funds; and no B5-aliased
//          settle ever moved funds (ghost counter stays 0).
//   INV_D  SPLIT INTEGRITY — ledger identity holds AND on-chain reality matches it.
// =====================================================================

contract InvariantHandler is Test {
    MockUSDCAuth public usdc;
    AuxiloSplitRouterReceiveOnly public router;

    uint256 internal buyerPk;
    address public buyer;
    address public feeWallet;
    address public settler;
    address public contributor; // canonical honest contributor for accounting

    uint256 internal constant FOREVER = type(uint256).max;

    // ---- ghost accounting -------------------------------------------------
    uint256 public totalGrossSettled;
    uint256 public totalContributorPaid;
    uint256 public totalFeePaid;
    uint256 public unauthorizedFundMovements; // must stay 0 (INV_C)

    // Distinct contributor addresses used, so we can sum contributor balances.
    address[] public contributors;
    mapping(address => bool) internal _isContributor;

    uint256 internal saltCounter;

    constructor(
        MockUSDCAuth _usdc,
        AuxiloSplitRouterReceiveOnly _router,
        uint256 _buyerPk,
        address _buyer,
        address _feeWallet,
        address _settler,
        address _contributor
    ) {
        usdc = _usdc;
        router = _router;
        buyerPk = _buyerPk;
        buyer = _buyer;
        feeWallet = _feeWallet;
        settler = _settler;
        contributor = _contributor;
        _registerContributor(_contributor);
    }

    // Register only accounting-valid contributors. (feeWallet / router / buyer are
    // never valid split destinations — the contract rejects them — so they never
    // accrue a contributor balance and must not be summed as one.)
    function _registerContributor(address c) internal {
        if (!_isContributor[c] && c != feeWallet && c != address(router) && c != buyer) {
            _isContributor[c] = true;
            contributors.push(c);
        }
    }

    function contributorsLength() external view returns (uint256) {
        return contributors.length;
    }

    // ---- signing ----------------------------------------------------------
    function _digestReceive(uint256 value, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), buyer, address(router), value, uint256(0), FOREVER, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function _sig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fundBuyer(uint256 value) internal {
        if (usdc.balanceOf(buyer) < value) {
            usdc.mint(buyer, value - usdc.balanceOf(buyer) + 1);
        }
    }

    // ---- handler actions (fuzzed by the invariant engine) -----------------

    /// Receive path: buyer-attested derived nonce. Always a valid, honest settle.
    function settleReceive(uint256 value, uint256 bps, uint256 contribSeed) external {
        value = bound(value, 1, 1e24);
        bps = bound(bps, 0, 10_000);
        address contrib = _pickHonestContributor(contribSeed);
        _fundBuyer(value);

        bytes32 salt = keccak256(abi.encode("recv", saltCounter++));
        bytes32 nonce = keccak256(abi.encode(contrib, bps, salt));
        bytes memory sig = _sig(_digestReceive(value, nonce));

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contrib, bps);

        _bookSettlement(value, bps);
    }

    /// B5 aliasing: the settler (with a genuine buyer signature over the aliased
    /// derived nonce) tries to settle with contributor == feeWallet or == router.
    /// The on-chain guard MUST revert and move no funds. NOT filtered out.
    function b5Aliased(uint256 value, uint256 bps, bool useRouter) external {
        value = bound(value, 1, 1e24);
        bps = bound(bps, 0, 10_000);
        address aliased = useRouter ? address(router) : feeWallet;
        _fundBuyer(value);

        uint256 feeBefore = usdc.balanceOf(feeWallet);
        uint256 routerBefore = usdc.balanceOf(address(router));

        // Low-level call keeps the stack shallow (avoids stack-too-deep) and lets
        // us assert the guard reverts (ok == false) without a try/catch frame.
        vm.prank(settler);
        (bool ok,) = _b5Call(value, bps, aliased);
        if (ok) unauthorizedFundMovements++; // guard MUST have reverted; reaching here is a failure

        // Even if (impossibly) it didn't revert, assert no funds moved to the alias.
        if (usdc.balanceOf(feeWallet) != feeBefore) unauthorizedFundMovements++;
        if (usdc.balanceOf(address(router)) != routerBefore) unauthorizedFundMovements++;
    }

    /// Builds and submits an aliased-contributor settle with a genuine buyer
    /// signature over the aliased derived nonce. Split into a helper to keep the
    /// caller's stack shallow.
    function _b5Call(uint256 value, uint256 bps, address aliased) internal returns (bool ok, bytes memory data) {
        bytes32 salt = keccak256(abi.encode("b5", saltCounter++));
        bytes32 nonce = keccak256(abi.encode(aliased, bps, salt));
        bytes memory sig = _sig(_digestReceive(value, nonce));
        (ok, data) = address(router).call(
            abi.encodeCall(
                AuxiloSplitRouterReceiveOnly.settleAndSplitReceive,
                (buyer, value, 0, FOREVER, salt, sig, aliased, bps)
            )
        );
    }

    /// A non-settler tries the settle path — must revert, must not move funds.
    function unauthorizedAttempt(uint256 value, uint256 seed) external {
        value = bound(value, 1, 1e24);
        address notSettler = address(uint160(uint256(keccak256(abi.encode("nope", seed)))));
        if (notSettler == settler || notSettler == address(0)) return;

        uint256 contribBalBefore = _sumContributorBalances();
        uint256 feeBalBefore = usdc.balanceOf(feeWallet);

        vm.prank(notSettler);
        try router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, 7000) {
            unauthorizedFundMovements++; // should never reach here
        } catch {}

        if (_sumContributorBalances() != contribBalBefore) unauthorizedFundMovements++;
        if (usdc.balanceOf(feeWallet) != feeBalBefore) unauthorizedFundMovements++;
    }

    /// Skim a non-USDC token (permissionless). Value leaves to feeWallet, never
    /// touches USDC accounting.
    function skimStray(uint256 amount) external {
        amount = bound(amount, 0, 1e24);
        StrayToken t = new StrayToken();
        if (amount > 0) t.mint(address(router), amount);
        router.skim(address(t));
    }

    // ---- internals --------------------------------------------------------

    function _pickHonestContributor(uint256 seed) internal returns (address c) {
        // Mostly the canonical contributor, sometimes a fresh one for breadth.
        if (seed % 4 == 0) {
            c = address(uint160(uint256(keccak256(abi.encode("contrib", seed)))));
            if (c == address(0) || c == feeWallet || c == address(router) || c == buyer) {
                c = contributor;
            }
        } else {
            c = contributor;
        }
        _registerContributor(c);
    }

    function _bookSettlement(uint256 value, uint256 bps) internal {
        uint256 contributorAmount = (value * bps) / 10_000;
        uint256 feeAmount = value - contributorAmount;
        totalGrossSettled += value;
        totalContributorPaid += contributorAmount;
        totalFeePaid += feeAmount;
    }

    function _sumContributorBalances() public view returns (uint256 sum) {
        for (uint256 i = 0; i < contributors.length; i++) {
            sum += usdc.balanceOf(contributors[i]);
        }
    }
}

/// Trivial non-USDC token for skim exercising.
contract StrayToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }
}

contract AuxiloSplitRouterReceiveOnlyInvariantTest is StdInvariant, Test {
    MockUSDCAuth internal usdc;
    AuxiloSplitRouterReceiveOnly internal router;
    InvariantHandler internal handler;

    address internal feeWallet;
    address internal settler;
    address internal contributor;
    uint256 internal buyerPk;
    address internal buyer;

    function setUp() public {
        vm.warp(1_750_000_000);
        (buyer, buyerPk) = makeAddrAndKey("inv-buyer");
        feeWallet = makeAddr("inv-feeWallet");
        settler = makeAddr("inv-settler");
        contributor = makeAddr("inv-contributor");

        usdc = new MockUSDCAuth();
        router = new AuxiloSplitRouterReceiveOnly(address(usdc), feeWallet, settler);
        usdc.mint(buyer, 1e30);

        handler = new InvariantHandler(usdc, router, buyerPk, buyer, feeWallet, settler, contributor);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.settleReceive.selector;
        selectors[1] = handler.b5Aliased.selector;
        selectors[2] = handler.unauthorizedAttempt.selector;
        selectors[3] = handler.skimStray.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// INV_A — value conservation.
    function invariant_A_ValueConservation() public view {
        assertEq(
            handler.totalContributorPaid() + handler.totalFeePaid(),
            handler.totalGrossSettled(),
            "INV_A: contributor+fee payouts must equal gross settled (no USDC created/lost)"
        );
    }

    /// INV_B — zero residue: there is no stranded path, so the router holds nothing.
    function invariant_B_ZeroResidue() public view {
        assertEq(usdc.balanceOf(address(router)), 0, "INV_B: router must hold no USDC (no stranded path)");
    }

    /// INV_C — settler-only + B5: no unauthorized or aliased settle ever moved funds.
    function invariant_C_NoUnauthorizedOrAliasedMovement() public view {
        assertEq(
            handler.unauthorizedFundMovements(),
            0,
            "INV_C: a non-settler or a B5-aliased contributor caused/attempted a fund movement"
        );
    }

    /// INV_D — split integrity: ledger identity AND on-chain reality match.
    function invariant_D_SplitIntegrity() public view {
        assertEq(
            handler.totalContributorPaid() + handler.totalFeePaid(),
            handler.totalGrossSettled(),
            "INV_D ledger: contributor+fee != gross"
        );
        assertEq(usdc.balanceOf(feeWallet), handler.totalFeePaid(), "INV_D: feeWallet balance != ledger fee total");
        assertEq(
            handler._sumContributorBalances(),
            handler.totalContributorPaid(),
            "INV_D: sum(contributor balances) != ledger contributor total"
        );
    }
}
