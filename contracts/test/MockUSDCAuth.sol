// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MockUSDCAuth — high-fidelity mock of Circle FiatTokenV2_2's EIP-3009 surface
 * (bytes-signature variants) for testing AuxiloSplitRouter.
 *
 * Fidelity points, matched to FiatTokenV2/V2_2 semantics:
 *   - EIP-712 domain: name "USD Coin", version "2", block.chainid, address(this).
 *   - RECEIVE_WITH_AUTHORIZATION_TYPEHASH / TRANSFER_WITH_AUTHORIZATION_TYPEHASH
 *     exactly per FiatTokenV2.
 *   - Real ecrecover verification over keccak256("\x19\x01" || domainSeparator || structHash).
 *   - Per-authorizer nonce tracking; reuse reverts with FiatTokenV2's string.
 *   - validAfter/validBefore window checks (strict inequalities, per FiatTokenV2:
 *     require(now > validAfter) and require(now < validBefore)).
 *   - receiveWithAuthorization enforces to == msg.sender ("caller must be the
 *     payee") — this is what makes the router's receive path front-run-proof,
 *     so the mock MUST enforce it.
 *   - 6 decimals, mint helper.
 *
 * Not modeled (irrelevant to the router tests): blacklisting, pausing,
 * EIP-1271 smart-account signatures, cancelAuthorization, fees.
 */
contract MockUSDCAuth {
    string public constant name = "USD Coin";
    string public constant version = "2";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    // Expected literal (FiatTokenV2): 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8
    // — asserted against the published value in the test suite.
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    // Expected literal (FiatTokenV2): 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 private immutable _DOMAIN_SEPARATOR;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    /// @dev authorizer => nonce => used (FiatTokenV2 `_authorizationStates`)
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() {
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    /**
     * EIP-3009 receiveWithAuthorization, bytes-signature variant (0x88b7ab63).
     * Enforces to == msg.sender: only the payee itself can submit, which is the
     * property AuxiloSplitRouter's Path A relies on for front-run-proofness.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external virtual {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _checkAuthorization(from, validAfter, validBefore, nonce);
        _requireValidSignature(
            from,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            signature
        );
        _markAuthorizationAsUsed(from, nonce);
        _transfer(from, to, value);
    }

    /**
     * EIP-3009 transferWithAuthorization, bytes-signature variant (0xcf092995).
     * ANY caller may submit — this is the griefing vector the router's
     * splitStranded() exists to recover from.
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external virtual {
        _checkAuthorization(from, validAfter, validBefore, nonce);
        _requireValidSignature(
            from,
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            signature
        );
        _markAuthorizationAsUsed(from, nonce);
        _transfer(from, to, value);
    }

    // -----------------------------------------------------------------
    // internals (mirroring FiatTokenV2 require-strings)
    // -----------------------------------------------------------------

    function _checkAuthorization(address authorizer, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        private
        view
    {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
    }

    function _requireValidSignature(address signer, bytes32 structHash, bytes calldata signature) private view {
        require(signature.length == 65, "ECRecover: invalid signature length");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "ECRecover: invalid signature 's' value");
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "ECRecover: invalid signature");
        require(recovered == signer, "FiatTokenV2: invalid signature");
    }

    function _markAuthorizationAsUsed(address authorizer, bytes32 nonce) private {
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "ERC20: transfer amount exceeds balance");
        unchecked {
            balanceOf[from] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
