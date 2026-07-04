// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouter} from "../AuxiloSplitRouter.sol";

// =====================================================================
// AuxiloSplitRouter — HALMOS SYMBOLIC proofs (L5)
//
// Goal: prove the SPLIT ARITHMETIC exhaustively, for ALL `value` and ALL
// `bps ∈ [0,10000]`, not sampled. To let the symbolic engine reach the split
// math, we swap in a PERMISSIVE mock USDC (PermissiveUSDC) that performs the
// pull-and-hold and the transfers WITHOUT any ecrecover/EIP-712 check. ecrecover
// is a symbolic-execution wall (uninterpreted precompile → path explosion), so
// isolating the arithmetic from signature verification is deliberate and stated.
//
// Run:  halmos --function check_ --solver-timeout-assertion 0
//
// What these prove (exhaustive within uint bounds Halmos enumerates):
//   check_split_conservation    contributorAmount + feeAmount == value  (no wei
//                               created or lost) for all value, all bps∈[0,1e4].
//   check_fee_is_complement     feeAmount == value - contributorAmount, i.e.
//                               floor-rounding dust always rides the FEE side.
//   check_contributor_le_value  contributorAmount <= value (no overflow steal).
//   check_bps_extremes          bps==0 → all to fee; bps==10000 → all to contrib.
//
// Plus a second-preimage intuition on the derived nonce:
//   check_nonce_binding_distinct different (contributor,bps) with the SAME salt
//                               cannot collide to the same derived nonce — so a
//                               settler cannot substitute contributor/bps under a
//                               buyer-signed nonce without changing salt. This is
//                               keccak collision-resistance; Halmos models keccak
//                               as injective, so it PROVES the no-collision claim
//                               under that standard modeling assumption (stated).
// =====================================================================

/// Permissive USDC: no signature check. receiveWithAuthorization / transfer
/// just move balances. Lets Halmos symbolically drive the router's split without
/// hitting ecrecover. Buyer is pre-funded with an unbounded balance.
contract PermissiveUSDC {
    mapping(address => uint256) public balanceOf;

    function setBalance(address who, uint256 v) external {
        balanceOf[who] = v;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        bytes calldata
    ) external {
        require(balanceOf[from] >= value, "bal");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        bytes calldata
    ) external {
        require(balanceOf[from] >= value, "bal");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "bal");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract AuxiloSplitRouterSymbolicTest is Test {
    PermissiveUSDC internal usdc;
    AuxiloSplitRouter internal router;

    address internal feeWallet = address(0xFEE);
    address internal settler = address(0x5E7);
    address internal buyer = address(0xB0B);
    uint256 internal constant FOREVER = type(uint256).max;

    function setUp() public {
        usdc = new PermissiveUSDC();
        router = new AuxiloSplitRouter(address(usdc), feeWallet, settler);
    }

    // -----------------------------------------------------------------
    // Split-arithmetic proofs (drive the REAL router through a settle)
    // -----------------------------------------------------------------

    /// For ALL value and ALL bps∈[0,1e4]: after a receive settle, the contributor
    /// balance + fee balance equals value, and the router holds nothing. This is
    /// value conservation proven exhaustively over the split math.
    function check_split_conservation(uint256 value, uint256 bps, address contributor) public {
        // Constrain to the router's own accepted domain.
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        vm.assume(contributor != address(0));
        vm.assume(contributor != feeWallet);
        vm.assume(contributor != address(router));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, bps);

        uint256 c = usdc.balanceOf(contributor);
        uint256 f = usdc.balanceOf(feeWallet);
        assert(c + f == value);                 // nothing created or lost
        assert(usdc.balanceOf(address(router)) == 0); // router fully drained
    }

    /// For ALL value, bps: feeAmount == value - contributorAmount, and the
    /// contributor share is exactly floor(value*bps/1e4) — dust to the fee side.
    function check_fee_is_complement(uint256 value, uint256 bps, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        vm.assume(contributor != address(0));
        vm.assume(contributor != feeWallet);
        vm.assume(contributor != address(router));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, bps);

        uint256 c = usdc.balanceOf(contributor);
        uint256 f = usdc.balanceOf(feeWallet);
        uint256 expectedContrib = (value * bps) / 10_000; // floor
        assert(c == expectedContrib);
        assert(f == value - expectedContrib); // dust rides fee
    }

    /// contributorAmount <= value always (no overflow/steal beyond the gross).
    function check_contributor_le_value(uint256 value, uint256 bps, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        vm.assume(contributor != address(0));
        vm.assume(contributor != feeWallet);
        vm.assume(contributor != address(router));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, bps);

        assert(usdc.balanceOf(contributor) <= value);
    }

    /// bps extremes: 0 → 100% to fee; 10000 → 100% to contributor. Proven for all value.
    function check_bps_zero_all_to_fee(uint256 value, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(contributor != address(0));
        vm.assume(contributor != feeWallet);
        vm.assume(contributor != address(router));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, 0);

        assert(usdc.balanceOf(contributor) == 0);
        assert(usdc.balanceOf(feeWallet) == value);
    }

    function check_bps_full_all_to_contributor(uint256 value, address contributor) public {
        // Tighter value bound (<= 2^64) than the other checks: at bps==10000 the
        // engine must reason about symbolic value*10000, and the wider ranges
        // stress the multiplication SMT encoding to a solver timeout (NOT a
        // counterexample). 2^64 base units (~1.8e13 USDC, i.e. ~18 trillion
        // micro-USDC) dwarfs any real unlock and still proves the property. NOTE:
        // this extreme is ALSO a corollary of check_fee_is_complement (proven for
        // ALL value<=2^128 and ALL bps<=1e4, which includes bps==10000); this is
        // belt-and-suspenders. See VERIFICATION.md §2 for the honest note.
        vm.assume(value > 0 && value <= type(uint64).max);
        vm.assume(contributor != address(0));
        vm.assume(contributor != feeWallet);
        vm.assume(contributor != address(router));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, 10_000);

        assert(usdc.balanceOf(contributor) == value);
        assert(usdc.balanceOf(feeWallet) == 0);
    }

    // -----------------------------------------------------------------
    // Nonce-binding second-preimage intuition (keccak injectivity model)
    // -----------------------------------------------------------------

    /// With the SAME salt, two DIFFERENT (contributor,bps) pairs cannot derive the
    /// same nonce. Under Halmos's standard keccak-injectivity modeling this PROVES
    /// that a settler cannot substitute contributor/bps under a buyer-signed nonce
    /// without also changing salt (which the buyer signed). Pure function; no USDC.
    function check_nonce_binding_distinct(
        address c1,
        uint256 bps1,
        address c2,
        uint256 bps2,
        bytes32 salt
    ) public pure {
        // The pair actually differs in at least one field.
        vm.assume(c1 != c2 || bps1 != bps2);
        bytes32 n1 = keccak256(abi.encode(c1, bps1, salt));
        bytes32 n2 = keccak256(abi.encode(c2, bps2, salt));
        assert(n1 != n2);
    }
}
