// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AuxiloSplitRouter — atomic non-custodial revenue split for x402 USDC unlocks.
 *
 * PURPOSE (R-01 / Option 1):
 *   The buyer agent signs ONE gasless EIP-3009 authorization paying this router
 *   the full unlock price. In the SAME transaction, the router:
 *     1. pulls the buyer's USDC via EIP-3009,
 *     2. transfers the contributor's share (70%/60%) DIRECTLY to the contributor
 *        wallet,
 *     3. transfers the remainder (the platform fee) to the immutable fee wallet.
 *
 *   The contributor's share is NEVER held by an Auxilo-controlled address —
 *   not for a single block. Auxilo receives only its own fee. This contract is
 *   immutable: no owner, no upgrade path, no pause, no arbitrary-withdraw.
 *   Auxilo cannot redirect or seize in-flight funds.
 *
 * TWO SETTLEMENT PATHS (x402 ecosystem interop):
 *   A. settleAndSplitReceive — uses USDC.receiveWithAuthorization. The buyer
 *      signs the ReceiveWithAuthorization typed struct. Front-run-proof by
 *      construction (msg.sender must equal the payee = this router), so the
 *      pull and the split are inseparable. PREFERRED path; used by clients
 *      that follow Auxilo's 402 challenge hints (e.g. the auxilo MCP client).
 *   B. settleAndSplitTransfer — uses USDC.transferWithAuthorization, the
 *      function the standard x402 "exact" EVM scheme specifies (verified
 *      against coinbase/x402 specs/schemes/exact/scheme_exact_evm.md,
 *      2026-07-03). Keeps Auxilo interoperable with ANY generic x402 agent
 *      client. Known EIP-3009 caveat: a third party who obtains the signed
 *      authorization could submit it directly to USDC, stranding the funds in
 *      this router without a split. That griefing (no profit to the griefer)
 *      is recovered by splitStranded(), which forces value to exit as a two-way
 *      (contributor + feeWallet) split. USDC held here in that window sits in an
 *      immutable contract with no Auxilo *withdrawal* path, not in an Auxilo
 *      wallet — BUT see the settler caveat below: the split's DESTINATION is
 *      settler-supplied, not contract-constrained.
 *
 * TRUST MODEL / LEGAL POSTURE — read honestly (red-team P1-1, 2026-07-03):
 *   - `feeWallet`, `usdc`, `settler` are immutable, set at deploy.
 *   - `settler` (Auxilo's operational key) is the only address that may invoke
 *     settlement/recovery. This prevents third-party replay with attacker-chosen
 *     split params, BUT it does NOT make Auxilo a mere executor: the settler
 *     supplies `contributor` and `bps`, and the contract only enforces that
 *     value leaves as a two-way split — NOT who the contributor is. A
 *     compromised or malicious settler can therefore name an arbitrary address
 *     as "contributor" and capture up to the full value. The settler key is a
 *     THEFT VECTOR and a residual-CONTROL surface (relevant to FinCEN
 *     independent-control and DFAL control-based analysis). Do not represent
 *     this contract as "Auxilo cannot divert funds" — it can, via the settler.
 *   - NONCE-BINDING ADOPTED on the Receive path (2026-07-03, red-team P1-1 fix):
 *     settleAndSplitReceive DERIVES the EIP-3009 nonce as
 *     keccak256(abi.encode(contributor, contributorBps, salt)) — it never
 *     accepts a caller-supplied nonce. The buyer signs that derived nonce, so
 *     the split destination and rate are BUYER-ATTESTED: if the settler alters
 *     contributor or bps, the derived nonce no longer matches the signed
 *     authorization and USDC's own signature check reverts. On this path the
 *     settler is demoted from controller to executor. The Transfer path and
 *     splitStranded CANNOT be bound (generic x402 clients pick random nonces);
 *     their retained settler discretion is the price of ecosystem interop and
 *     must be disclosed to counsel as such.
 *   - USDC exits only via a split (settler-directed destination) or, for
 *     non-USDC accidental tokens, skim-to-feeWallet.
 *
 * AUDIT NOTES (for the external auditor + fintech counsel):
 *   1. ADOPTED (Receive path): split params are bound into the EIP-3009 nonce —
 *      nonce = keccak256(abi.encode(contributor, contributorBps, salt)),
 *      derived in-contract, never caller-supplied. Auxilo-aware buyer clients
 *      must compute the same nonce before signing (the 402 challenge's `extra`
 *      hint carries contributor/bps/salt). The Transfer path and splitStranded
 *      remain settler-discretionary: generic x402 clients generate random
 *      nonces and cannot comply. Auditor: confirm the derivation makes settler
 *      substitution of contributor/bps unexpressible on path 1.
 *   2. Uses the bytes-signature EIP-3009 variants (receive 0x88b7ab63,
 *      transfer 0xcf092995) — both verified present in Base USDC
 *      FiatTokenV2_2 impl 0x2ce6311ddae708829bc0784c967b7d77d19fd779
 *      (on-chain bytecode check, 2026-07-03). Bytes variants support EOA
 *      (65-byte ECDSA) and EIP-1271 smart-account buyers (agent wallets are
 *      frequently smart accounts).
 *   3. USDC has no transfer hooks; pull-then-push is single-token, same-tx.
 *      Reentrancy guard included anyway.
 *   4. skim() deliberately excludes USDC so stranded contributor funds can
 *      never be swept to the fee wallet; USDC exits only via a split.
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

    function transferWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        bytes calldata signature
    ) external;
}

contract AuxiloSplitRouter {
    /// @notice USDC token (Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
    IUSDCAuth public immutable usdc;

    /// @notice Immutable platform-fee destination.
    address public immutable feeWallet;

    /// @notice Sole address allowed to trigger settlement/recovery.
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
        uint8 path // 1 = receive, 2 = transfer, 3 = stranded-recovery
    );

    event Skimmed(address indexed token, uint256 amount);

    error NotSettler();
    error Reentrancy();
    error ZeroContributor();
    error BpsTooHigh();
    error ZeroValue();
    error UsdcNotSkimmable();
    error InsufficientStranded();

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
    // Path A — receiveWithAuthorization (preferred, front-run-proof,
    // buyer-attested split via derived nonce)
    // ---------------------------------------------------------------
    /**
     * The EIP-3009 nonce is DERIVED in-contract from (contributor, bps, salt);
     * there is no nonce parameter, so a non-conforming nonce cannot be passed.
     * The buyer's client computes the identical derivation before signing (the
     * 402 challenge's `extra` hint carries contributor/bps/salt). If the
     * settler substitutes contributor or bps, the derived nonce differs from
     * the one the buyer signed and USDC's signature verification reverts —
     * there is no router-level error path for tampering, it is unexpressible.
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
        _split(nonce, from, contributor, value, contributorBps, 1);
    }

    // ---------------------------------------------------------------
    // Path B — transferWithAuthorization (standard x402 exact scheme)
    // ---------------------------------------------------------------
    function settleAndSplitTransfer(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        address contributor,
        uint256 contributorBps
    ) external onlySettler nonReentrant {
        _validate(contributor, contributorBps, value);
        usdc.transferWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        _split(nonce, from, contributor, value, contributorBps, 2);
    }

    /**
     * Recovery: complete the intended split for an authorization a third party
     * submitted directly to USDC (funds landed here with no split — the known
     * transferWithAuthorization griefing vector). Forces value out as a two-way
     * (contributor, feeWallet) split. NOTE (red-team P1-1): `contributor` is
     * settler-supplied and unconstrained, so this bounds the SHAPE of the exit,
     * not its DESTINATION — a malicious settler could name its own address.
     * No on-chain replay guard: off-chain reconciliation must dedup on authNonce.
     */
    function splitStranded(
        bytes32 authNonce,
        address buyer,
        address contributor,
        uint256 value,
        uint256 contributorBps
    ) external onlySettler nonReentrant {
        _validate(contributor, contributorBps, value);
        if (usdc.balanceOf(address(this)) < value) revert InsufficientStranded();
        _split(authNonce, buyer, contributor, value, contributorBps, 3);
    }

    /**
     * Recover non-USDC tokens accidentally sent here. Permissionless; funds can
     * only go to the immutable feeWallet. USDC is deliberately excluded so a
     * stranded contributor share can never be swept away from its split.
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
    function _validate(address contributor, uint256 contributorBps, uint256 value) private pure {
        if (contributor == address(0)) revert ZeroContributor();
        if (contributorBps > BPS_DENOMINATOR) revert BpsTooHigh();
        if (value == 0) revert ZeroValue();
    }

    function _split(
        bytes32 nonce,
        address buyer,
        address contributor,
        uint256 value,
        uint256 contributorBps,
        uint8 path
    ) private {
        uint256 contributorAmount = (value * contributorBps) / BPS_DENOMINATOR;
        uint256 feeAmount = value - contributorAmount;

        if (contributorAmount > 0) {
            require(usdc.transfer(contributor, contributorAmount), "contrib transfer failed");
        }
        if (feeAmount > 0) {
            require(usdc.transfer(feeWallet, feeAmount), "fee transfer failed");
        }

        emit Settled(nonce, buyer, contributor, value, contributorAmount, feeAmount, path);
    }
}
