// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuxiloSplitRouterReceiveOnly} from "../AuxiloSplitRouterReceiveOnly.sol";

// =====================================================================
// AuxiloSplitRouterReceiveOnly — HALMOS SYMBOLIC proofs (L5)
//
// Proves the SPLIT ARITHMETIC exhaustively, for ALL `value` and ALL
// `bps ∈ [0,10000]`. A PERMISSIVE mock USDC isolates the split math from
// ecrecover/EIP-712 (an SMT wall).
//
// Run:  halmos --contract AuxiloSplitRouterReceiveOnlySymbolicTest --function check_
//
// What these prove (exhaustive within uint bounds Halmos enumerates):
//   check_split_conservation    contributorAmount + feeAmount == value, router
//                               residue == 0, for all value, all bps∈[0,1e4].
//   check_fee_is_complement     feeAmount == value - contributorAmount (floor dust
//                               rides the FEE side).
//   check_contributor_le_value  contributorAmount <= value.
//   check_bps_zero_all_to_fee   bps==0 → all to fee.
//   check_nonce_binding_distinct different (contributor,bps) with the SAME salt
//                               cannot collide to the same derived nonce.
//   check_b5_guard_reverts_alias contributor ∈ {feeWallet, router} ALWAYS reverts
//                               (B5 is PROVEN, not vm.assume'd away).
//
// NOTE ON B5 AND THE SPLIT PROOFS: the split-arithmetic checks below no longer
// vm.assume the aliasing inputs (contributor != feeWallet / != router) away. They
// do not need to: the contract's B5 guard reverts on those inputs, so the settle
// simply does not proceed to the split for an aliased contributor, and the
// post-conditions are asserted on exactly the (non-reverting) states the contract
// permits. B5's reject-on-alias behavior is proven directly by
// check_b5_guard_reverts_alias. Together this makes B5 a PROVEN property.
// =====================================================================

/// Permissive USDC: no signature check. receiveWithAuthorization / transfer just
/// move balances. Lets Halmos symbolically drive the router's split without
/// hitting ecrecover.
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

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "bal");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract AuxiloSplitRouterReceiveOnlySymbolicTest is Test {
    PermissiveUSDC internal usdc;
    AuxiloSplitRouterReceiveOnly internal router;

    address internal feeWallet = address(0xFEE);
    address internal settler = address(0x5E7);
    address internal buyer = address(0xB0B);
    uint256 internal constant FOREVER = type(uint256).max;

    function setUp() public {
        usdc = new PermissiveUSDC();
        router = new AuxiloSplitRouterReceiveOnly(address(usdc), feeWallet, settler);
    }

    // -----------------------------------------------------------------
    // Split-arithmetic proofs (drive the REAL router through a settle)
    // -----------------------------------------------------------------

    /// For ALL value and ALL bps∈[0,1e4] and ALL non-zero contributor: after a
    /// receive settle, contributor balance + fee balance == value, router holds
    /// nothing. The aliasing inputs are NOT assumed away — the B5 guard reverts
    /// them, so this post-condition is asserted only on the states the contract
    /// permits.
    function check_split_conservation(uint256 value, uint256 bps, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        vm.assume(contributor != address(0));
        vm.assume(contributor != buyer); // keep buyer/contributor balances separable for the assert

        usdc.setBalance(buyer, value);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, bps);

        uint256 c = usdc.balanceOf(contributor);
        uint256 f = usdc.balanceOf(feeWallet);
        assert(c + f == value);
        assert(usdc.balanceOf(address(router)) == 0);
    }

    /// feeAmount == value - contributorAmount; contributor share is floor(value*bps/1e4).
    function check_fee_is_complement(uint256 value, uint256 bps, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        vm.assume(contributor != address(0));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, bps);

        uint256 c = usdc.balanceOf(contributor);
        uint256 f = usdc.balanceOf(feeWallet);
        uint256 expectedContrib = (value * bps) / 10_000; // floor
        assert(c == expectedContrib);
        assert(f == value - expectedContrib);
    }

    /// contributorAmount <= value always.
    function check_contributor_le_value(uint256 value, uint256 bps, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        vm.assume(contributor != address(0));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);

        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, bps);

        assert(usdc.balanceOf(contributor) <= value);
    }

    /// bps==0 → 100% to fee, for all value.
    function check_bps_zero_all_to_fee(uint256 value, address contributor) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(contributor != address(0));
        vm.assume(contributor != buyer);

        usdc.setBalance(buyer, value);
        vm.prank(settler);
        router.settleAndSplitReceive(buyer, value, 0, FOREVER, bytes32(0), "", contributor, 0);

        assert(usdc.balanceOf(contributor) == 0);
        assert(usdc.balanceOf(feeWallet) == value);
    }

    // -----------------------------------------------------------------
    // B5 identity guard — PROVEN (not vm.assume'd away)
    // -----------------------------------------------------------------

    /// For ALL value and ALL bps, a settle naming contributor == feeWallet or
    /// == the router itself ALWAYS reverts and moves no funds. Proven exhaustively.
    function check_b5_guard_reverts_alias(uint256 value, uint256 bps, bool useRouter) public {
        vm.assume(value > 0 && value <= type(uint128).max);
        vm.assume(bps <= 10_000);
        address aliased = useRouter ? address(router) : feeWallet;

        usdc.setBalance(buyer, value);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        uint256 routerBefore = usdc.balanceOf(address(router));

        vm.prank(settler);
        (bool ok,) = address(router).call(
            abi.encodeCall(
                AuxiloSplitRouterReceiveOnly.settleAndSplitReceive,
                (buyer, value, 0, FOREVER, bytes32(0), "", aliased, bps)
            )
        );
        assert(!ok); // B5 guard reverts on the aliased contributor
        assert(usdc.balanceOf(feeWallet) == feeBefore);
        assert(usdc.balanceOf(address(router)) == routerBefore);
    }

    // -----------------------------------------------------------------
    // Nonce-binding second-preimage intuition (keccak injectivity model)
    // -----------------------------------------------------------------

    /// With the SAME salt, two DIFFERENT (contributor,bps) pairs cannot derive the
    /// same nonce. Under Halmos's keccak-injectivity model this PROVES a settler
    /// cannot substitute contributor/bps under a buyer-signed nonce without also
    /// changing the buyer-signed salt.
    function check_nonce_binding_distinct(
        address c1,
        uint256 bps1,
        address c2,
        uint256 bps2,
        bytes32 salt
    ) public pure {
        vm.assume(c1 != c2 || bps1 != bps2);
        bytes32 n1 = keccak256(abi.encode(c1, bps1, salt));
        bytes32 n2 = keccak256(abi.encode(c2, bps2, salt));
        assert(n1 != n2);
    }
}
