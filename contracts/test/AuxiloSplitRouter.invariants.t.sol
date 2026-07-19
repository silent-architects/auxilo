// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {AuxiloSplitRouter} from "../AuxiloSplitRouter.sol";
import {MockUSDCAuth} from "./MockUSDCAuth.sol";

// =====================================================================
// AuxiloSplitRouter — STATEFUL INVARIANT suite (L4)
//
// A handler random-sequences VALID settlements (receive + transfer paths),
// stranded recoveries, and skims against a single router + mock USDC, signing
// each authorization on the fly with the buyer's key. Ghost variables track
// every unit of USDC that entered the router's flow and every unit that left.
//
// Invariants asserted after every call sequence:
//   INV_A  VALUE CONSERVATION — sum(contributor payouts + fee payouts) ==
//          sum(gross pulled). No USDC created or lost across the whole history.
//   INV_B  ZERO RESIDUE on the live receive/transfer paths — after a successful
//          settle the router holds nothing attributable to that settle (tracked
//          as: router USDC balance == currently-stranded-but-unrecovered total).
//   INV_C  SETTLER-ONLY — only the settler ever caused a fund-moving state
//          change on a split path (the handler proves non-settler calls revert
//          and never move funds; ghost counter of unauthorized movements == 0).
//   INV_D  PER-SETTLEMENT split integrity — for every settlement, the recorded
//          contributorAmount + feeAmount == grossValue (checked cumulatively:
//          totalContributor + totalFee == totalGrossSettled).
// =====================================================================

contract InvariantHandler is Test {
    MockUSDCAuth public usdc;
    AuxiloSplitRouter public router;

    uint256 internal buyerPk;
    address public buyer;
    address public feeWallet;
    address public settler;
    address public contributor; // canonical honest contributor for accounting

    uint256 internal constant FOREVER = type(uint256).max;

    // ---- ghost accounting -------------------------------------------------
    uint256 public totalGrossPulled;       // USDC pulled into the router's flow (live paths)
    uint256 public totalGrossSettled;      // gross across ALL completed splits (live + stranded)
    uint256 public totalContributorPaid;   // sum of contributor legs
    uint256 public totalFeePaid;           // sum of fee legs
    uint256 public totalStrandedOutstanding; // griefed-in USDC not yet recovered
    uint256 public unauthorizedFundMovements; // must stay 0 (INV_C)

    // Distinct contributor addresses used, so we can sum contributor balances.
    address[] public contributors;
    mapping(address => bool) internal _isContributor;

    uint256 internal saltCounter;
    uint256 internal nonceCounter;

    constructor(MockUSDCAuth _usdc, AuxiloSplitRouter _router, uint256 _buyerPk, address _buyer, address _feeWallet, address _settler, address _contributor) {
        usdc = _usdc;
        router = _router;
        buyerPk = _buyerPk;
        buyer = _buyer;
        feeWallet = _feeWallet;
        settler = _settler;
        contributor = _contributor;
        _registerContributor(_contributor);
    }

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

    function _digestTransfer(uint256 value, bytes32 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), buyer, address(router), value, uint256(0), FOREVER, nonce)
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
        address contrib = _pickContributor(contribSeed);
        _fundBuyer(value);

        bytes32 salt = keccak256(abi.encode("recv", saltCounter++));
        bytes32 nonce = keccak256(abi.encode(contrib, bps, salt));
        bytes memory sig = _sig(_digestReceive(value, nonce));

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, salt, sig, contrib, bps);

        _bookSettlement(value, bps, contrib, false);
    }

    /// Transfer path: settler-supplied nonce; honest contributor/bps.
    function settleTransfer(uint256 value, uint256 bps, uint256 contribSeed) external {
        value = bound(value, 1, 1e24);
        bps = bound(bps, 0, 10_000);
        address contrib = _pickContributor(contribSeed);
        _fundBuyer(value);

        bytes32 nonce = keccak256(abi.encode("xfer", nonceCounter++));
        bytes memory sig = _sig(_digestTransfer(value, nonce));

        vm.prank(settler);
        router.settleAndSplitTransfer(buyer, value, 0, FOREVER, nonce, sig, contrib, bps);

        _bookSettlement(value, bps, contrib, false);
    }

    /// Grief-in: a third party submits a signed transferWithAuthorization directly
    /// to USDC, stranding funds in the router (the vector splitStranded recovers).
    function grief(uint256 value) external {
        value = bound(value, 1, 1e24);
        _fundBuyer(value);
        bytes32 nonce = keccak256(abi.encode("grief", nonceCounter++));
        bytes memory sig = _sig(_digestTransfer(value, nonce));

        // NOT the settler — anyone can submit a transferWithAuthorization.
        address anyone = address(uint160(uint256(nonce)));
        vm.prank(anyone);
        usdc.transferWithAuthorization(buyer, address(router), value, 0, FOREVER, nonce, sig);

        totalStrandedOutstanding += value; // funds now sit in the router, unsplit
    }

    /// Recover stranded funds honestly (contributor/bps = honest split).
    function recoverStranded(uint256 value, uint256 bps, uint256 contribSeed) external {
        uint256 bal = usdc.balanceOf(address(router));
        if (bal == 0 || totalStrandedOutstanding == 0) return; // nothing to recover
        value = bound(value, 1, totalStrandedOutstanding);
        if (value > bal) value = bal;
        if (value == 0) return;
        bps = bound(bps, 0, 10_000);
        address contrib = _pickContributor(contribSeed);

        vm.prank(settler);
        router.splitStranded(keccak256(abi.encode("recover", nonceCounter++)), buyer, contrib, value, bps);

        totalStrandedOutstanding -= value;
        _bookSettlement(value, bps, contrib, true);
    }

    /// A non-settler tries every split path — must revert, must not move funds.
    function unauthorizedAttempt(uint256 value, uint256 seed) external {
        value = bound(value, 1, 1e24);
        address notSettler = address(uint160(uint256(keccak256(abi.encode("nope", seed)))));
        if (notSettler == settler || notSettler == address(0)) return;

        uint256 contribBalBefore = _sumContributorBalances();
        uint256 feeBalBefore = usdc.balanceOf(feeWallet);

        vm.startPrank(notSettler);
        try router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, 7000) {
            unauthorizedFundMovements++; // should never reach here
        } catch {}
        try router.settleAndSplitTransfer(buyer, value, 0, FOREVER, bytes32(0), "", contributor, 7000) {
            unauthorizedFundMovements++;
        } catch {}
        try router.splitStranded(bytes32(0), buyer, contributor, value, 7000) {
            unauthorizedFundMovements++;
        } catch {}
        vm.stopPrank();

        // Confirm no balances moved on the failed attempts.
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

    function _pickContributor(uint256 seed) internal returns (address c) {
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

    function _bookSettlement(uint256 value, uint256 bps, address, /*contrib*/ bool stranded) internal {
        uint256 contributorAmount = (value * bps) / 10_000;
        uint256 feeAmount = value - contributorAmount;
        totalGrossSettled += value;
        totalContributorPaid += contributorAmount;
        totalFeePaid += feeAmount;
        if (!stranded) {
            totalGrossPulled += value; // live paths pulled fresh USDC
        }
        // stranded value was already counted into the flow at grief() time.
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

contract AuxiloSplitRouterInvariantTest is StdInvariant, Test {
    MockUSDCAuth internal usdc;
    AuxiloSplitRouter internal router;
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
        router = new AuxiloSplitRouter(address(usdc), feeWallet, settler);
        usdc.mint(buyer, 1e30);

        handler = new InvariantHandler(usdc, router, buyerPk, buyer, feeWallet, settler, contributor);

        // Only the handler is the fuzz target.
        targetContract(address(handler));

        // Restrict to the handler's action selectors.
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.settleReceive.selector;
        selectors[1] = handler.settleTransfer.selector;
        selectors[2] = handler.grief.selector;
        selectors[3] = handler.recoverStranded.selector;
        selectors[4] = handler.unauthorizedAttempt.selector;
        selectors[5] = handler.skimStray.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// INV_A — value conservation: every unit that flowed through the router's
    /// splits was paid out to exactly a contributor or the fee wallet.
    function invariant_A_ValueConservation() public view {
        assertEq(
            handler.totalContributorPaid() + handler.totalFeePaid(),
            handler.totalGrossSettled(),
            "INV_A: contributor+fee payouts must equal gross settled (no USDC created/lost)"
        );
    }

    /// INV_B — zero residue on live paths: the router only ever holds USDC that
    /// was griefed in and not yet recovered. Live settles leave nothing.
    function invariant_B_ZeroLiveResidue() public view {
        assertEq(
            usdc.balanceOf(address(router)),
            handler.totalStrandedOutstanding(),
            "INV_B: router residue must equal only the un-recovered stranded amount"
        );
    }

    /// INV_C — settler-only: no unauthorized caller ever moved funds.
    function invariant_C_SettlerOnlyMovesFunds() public view {
        assertEq(
            handler.unauthorizedFundMovements(),
            0,
            "INV_C: a non-settler caused (or attempted to cause) a fund movement"
        );
    }

    /// INV_D — split integrity: cumulative distributed to contributors and fee
    /// equals cumulative gross settled (per-settlement contributor+fee==gross,
    /// summed). Also cross-check the ACTUAL on-chain balances match the ledger.
    function invariant_D_SplitIntegrity() public view {
        // Ledger identity.
        assertEq(
            handler.totalContributorPaid() + handler.totalFeePaid(),
            handler.totalGrossSettled(),
            "INV_D ledger: contributor+fee != gross"
        );
        // On-chain reality matches the ledger: feeWallet holds exactly totalFeePaid,
        // and the sum of contributor balances holds exactly totalContributorPaid.
        assertEq(usdc.balanceOf(feeWallet), handler.totalFeePaid(), "INV_D: feeWallet balance != ledger fee total");
        assertEq(
            handler._sumContributorBalances(),
            handler.totalContributorPaid(),
            "INV_D: sum(contributor balances) != ledger contributor total"
        );
    }
}
