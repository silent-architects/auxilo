// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AuxiloSplitRouterReceiveOnly — atomic non-custodial revenue split for x402
 * USDC unlocks, RECEIVE-ONLY MVP variant.
 *
 * This is the bootstrapped-MVP contract. It is a STRICT SUBSET of the both-paths
 * AuxiloSplitRouter.sol: it keeps ONLY the buyer-attested Receive path and drops
 * the standard-x402 Transfer path and the stranded-recovery path entirely. That
 * cut is the whole point — see the trust model below.
 *
 * PURPOSE (R-01 / Option 1):
 *   The buyer agent signs ONE gasless EIP-3009 ReceiveWithAuthorization paying
 *   this router the full unlock price. In the SAME transaction, the router:
 *     1. pulls the buyer's USDC via receiveWithAuthorization,
 *     2. transfers the contributor's share (70%/60%) DIRECTLY to the contributor
 *        wallet,
 *     3. transfers the remainder (the platform fee) to the immutable fee wallet.
 *
 *   The contributor's share is NEVER held by an Auxilo-controlled address — not
 *   for a single block. Auxilo receives only its own fee. This contract is
 *   immutable: no owner, no upgrade path, no pause, no arbitrary-withdraw.
 *
 * SINGLE SETTLEMENT PATH — settleAndSplitReceive (buyer-attested):
 *   Uses USDC.receiveWithAuthorization. The buyer signs the ReceiveWithAuthorization
 *   typed struct. Front-run-proof by construction (USDC enforces msg.sender ==
 *   payee == this router), so the pull and the split are inseparable. The EIP-3009
 *   nonce is DERIVED in-contract as keccak256(abi.encode(contributor, contributorBps,
 *   salt)); there is no caller-supplied nonce parameter. The buyer's client computes
 *   the identical derivation before signing (the 402 challenge's `extra` hint carries
 *   contributor/bps/salt).
 *
 * TRUST MODEL / LEGAL POSTURE — read honestly (receive-only MVP, 2026-07-04):
 *   - `feeWallet`, `usdc`, `settler` are immutable, set at deploy.
 *   - `settler` (Auxilo's operational key) is the only address that may invoke
 *     settlement. This prevents third-party replay with attacker-chosen split
 *     params.
 *   - BUYER-ATTESTED SPLIT — because the ONLY path derives the EIP-3009 nonce from
 *     (contributor, contributorBps, salt) and the buyer signs that exact derived
 *     nonce, the split destination and rate are BUYER-ATTESTED on EVERY settlement.
 *     If the settler substitutes contributor or bps, the derived nonce no longer
 *     matches the signed authorization and USDC's own signature check reverts —
 *     there is no router-level error path for tampering; it is unexpressible.
 *   - CONSEQUENCE — the settler is a pure EXECUTOR on this contract, never a
 *     controller. There is NO Transfer path and NO stranded-recovery path, so
 *     there is NO settlement on which the settler retains destination discretion.
 *     A compromised or malicious settler CANNOT divert funds on ANY path: the
 *     worst it can do is fail to settle (a liveness denial), not misdirect a
 *     settlement. For this contract, "Auxilo cannot divert funds" is STRUCTURALLY
 *     TRUE for 100% of settlements — not a claim contingent on off-chain honesty.
 *   - This is the deliberate difference from the both-paths FUTURE variant
 *     (AuxiloSplitRouter.sol), which retains a settler-discretionary Transfer /
 *     Stranded surface for generic-x402 interop and MUST be disclosed to counsel
 *     as such. That contract is the separate ecosystem-interop deployment; this
 *     MVP trades that interop away to make the non-diversion property structural.
 *   - USDC exits only via a buyer-attested split. Non-USDC accidental tokens exit
 *     via skim-to-feeWallet; USDC is never skimmable.
 *   - IDENTITY GUARD (B5): the contributor may not be the feeWallet or this
 *     contract itself (in addition to the zero address). This keeps every
 *     settlement's accounting well-formed — no contributor leg mis-booked into the
 *     fee wallet, no share re-stranded in the router under a "Settled" banner.
 *
 * AUDIT NOTES (for the external auditor + fintech counsel):
 *   1. Split params are bound into the EIP-3009 nonce —
 *      nonce = keccak256(abi.encode(contributor, contributorBps, salt)), derived
 *      in-contract, never caller-supplied. Auxilo-aware buyer clients must compute
 *      the same nonce before signing (the 402 challenge's `extra` hint carries
 *      contributor/bps/salt). Auditor: confirm the derivation makes settler
 *      substitution of contributor/bps unexpressible — there is no other path on
 *      which it could be expressed.
 *   2. Uses the bytes-signature EIP-3009 receive variant (0x88b7ab63) — verified
 *      present in Base USDC FiatTokenV2_2 impl
 *      0x2ce6311ddae708829bc0784c967b7d77d19fd779 (on-chain bytecode check,
 *      2026-07-03). The bytes variant supports EOA (65-byte ECDSA) and EIP-1271
 *      smart-account buyers (agent wallets are frequently smart accounts).
 *   3. USDC has no transfer hooks; pull-then-push is single-token, same-tx.
 *      Reentrancy guard included anyway.
 *   4. skim() deliberately excludes USDC so contributor funds can never be swept
 *      to the fee wallet; USDC exits only via a buyer-attested split.
 *   5. The identity guard (contributor != feeWallet, != address(this)) is enforced
 *      in _validate and is exercised as a proven property in the test suite — it
 *      is not harness-excluded.
 */

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUSDCAuth is IERC20Minimal {
    function receiveWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        bytes calldata signature
    ) external;
}

contract AuxiloSplitRouterReceiveOnly {
    /// @notice USDC token (Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    IUSDCAuth public immutable usdc;

    /// @notice Immutable platform-fee destination.
    address public immutable feeWallet;

    /// @notice Sole address allowed to trigger settlement.
    address public immutable settler;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    uint256 private _entered = 1;

    event Settled(
        bytes32 indexed authNonce,
        address indexed buyer,
        address indexed contributor,
        uint256 grossValue,
        uint256 contributorAmount,
        uint256 feeAmount,
        uint8 path // always 1 = receive (single path; retained for reconciliation parity)
    );

    event Skimmed(address indexed token, uint256 amount);

    error NotSettler();
    error Reentrancy();
    error ZeroContributor();
    error BadContributor();
    error BpsTooHigh();
    error ZeroValue();
    error UsdcNotSkimmable();

    constructor(address usdc_, address feeWallet_, address settler_) {
        require(usdc_ != address(0) && feeWallet_ != address(0) && settler_ != address(0), "zero addr");
        usdc = IUSDCAuth(usdc_);
        feeWallet = feeWallet_;
        settler = settler_;
    }

    modifier onlySettler() {
        if (msg.sender != settler) revert NotSettler();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    // ---------------------------------------------------------------
    // The ONLY settlement path — receiveWithAuthorization
    // (front-run-proof; buyer-attested split via derived nonce)
    // ---------------------------------------------------------------
    /**
     * The EIP-3009 nonce is DERIVED in-contract from (contributor, bps, salt);
     * there is no nonce parameter, so a non-conforming nonce cannot be passed.
     * The buyer's client computes the identical derivation before signing (the
     * 402 challenge's `extra` hint carries contributor/bps/salt). If the settler
     * substitutes contributor or bps, the derived nonce differs from the one the
     * buyer signed and USDC's signature verification reverts — there is no
     * router-level error path for tampering, it is unexpressible.
     * `salt` must be unique per payment (client-chosen randomness) to satisfy
     * EIP-3009 nonce uniqueness per authorizer.
     */
    function settleAndSplitReceive(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature,
        address contributor,
        uint256 contributorBps
    ) external onlySettler nonReentrant {
        _validate(contributor, contributorBps, value);
        bytes32 nonce = keccak256(abi.encode(contributor, contributorBps, salt));
        usdc.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        _split(nonce, from, contributor, value, contributorBps);
    }

    /**
     * Recover non-USDC tokens accidentally sent here. Permissionless; funds can
     * only go to the immutable feeWallet. USDC is deliberately excluded so a
     * contributor share can never be swept away from its split.
     */
    function skim(address token) external nonReentrant {
        if (token == address(usdc)) revert UsdcNotSkimmable();
        uint256 bal = IERC20Minimal(token).balanceOf(address(this));
        if (bal > 0) {
            require(IERC20Minimal(token).transfer(feeWallet, bal), "skim failed");
            emit Skimmed(token, bal);
        }
    }

    // ---------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------
    function _validate(address contributor, uint256 contributorBps, uint256 value) private view {
        if (contributor == address(0)) revert ZeroContributor();
        // B5 identity guard: contributor must not be the fee wallet (would
        // mis-book the contributor leg) or this contract (would re-strand the
        // share under a Settled event with no recovery path).
        if (contributor == feeWallet || contributor == address(this)) revert BadContributor();
        if (contributorBps > BPS_DENOMINATOR) revert BpsTooHigh();
        if (value == 0) revert ZeroValue();
    }

    function _split(
        bytes32 nonce,
        address buyer,
        address contributor,
        uint256 value,
        uint256 contributorBps
    ) private {
        uint256 contributorAmount = (value * contributorBps) / BPS_DENOMINATOR;
        uint256 feeAmount = value - contributorAmount;

        if (contributorAmount > 0) {
            require(usdc.transfer(contributor, contributorAmount), "contrib transfer failed");
        }
        if (feeAmount > 0) {
            require(usdc.transfer(feeWallet, feeAmount), "fee transfer failed");
        }

        emit Settled(nonce, buyer, contributor, value, contributorAmount, feeAmount, 1);
    }
}
