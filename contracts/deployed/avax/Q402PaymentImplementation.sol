// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402PaymentImplementation
 * @notice EIP-7702 Delegated Gasless Payment Implementation — Avalanche C-Chain
 * @dev Implements the Q402 protocol: sign-to-pay gasless ERC-20 transfers.
 *
 *  Architecture (EIP-7702 flow):
 *  ┌──────────┐  sign EIP-712   ┌─────────────────────────────┐
 *  │  User    │ ───────────────▶ │  Q402PaymentImplementation  │
 *  │  (EOA)   │                  │  (deployed implementation)  │
 *  └──────────┘                  └─────────────────────────────┘
 *       │                                    │
 *       │  EIP-7702 delegation               │ verifies sig
 *       ▼                                    │ transfers token
 *  ┌──────────┐  Type-0x04 tx   ┌───────────▼─────────────────┐
 *  │Facilitator│ ──────────────▶ │   User EOA (delegated code) │
 *  │(gas sponsor)│               │   IERC20.transfer(...)      │
 *  └──────────┘                  └─────────────────────────────┘
 *
 *  EIP-712 domain name : "Q402 Avalanche"
 *  Witness type        : TransferAuthorization
 *  Chain ID (Fuji)     : 43113
 *  Chain ID (Mainnet)  : 43114
 */
contract Q402PaymentImplementation {

    // ─── EIP-712 Type Hashes ──────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant TRANSFER_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferAuthorization("
            "address owner,"
            "address facilitator,"
            "address token,"
            "address recipient,"
            "uint256 amount,"
            "uint256 nonce,"
            "uint256 deadline"
        ")"
    );

    string public constant NAME    = "Q402 Avalanche";
    string public constant VERSION = "1";

    // ─── State (stored in user EOA storage under EIP-7702 delegation) ─────────

    /// @notice Tracks used nonces per owner — prevents replay attacks
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice Emitted on every successful gasless transfer
    event TransferExecuted(
        address indexed owner,
        address indexed facilitator,
        address indexed token,
        address          recipient,
        uint256          amount,
        uint256          nonce
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error SignatureExpired();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error TransferFailed();
    error InvalidSignatureLength();
    error OwnerMismatch();
    error InvalidOwner();
    error UnauthorizedFacilitator();

    // ─── Core Function ────────────────────────────────────────────────────────

    /**
     * @notice Execute a gasless ERC-20 transfer via EIP-7702 delegation.
     *
     * @dev Called by the Facilitator (who pays AVAX gas) after setting the
     *      EIP-7702 delegation on the user's EOA.
     *      Under EIP-7702: `address(this)` == user's EOA, so IERC20.transfer()
     *      sends tokens directly from the user's balance without allowance.
     *
     * @param owner            Token owner — the user whose EOA is delegated.
     * @param facilitator      Gas sponsor address (the caller).
     * @param token            ERC-20 token contract address (e.g. USDC.e on Avalanche).
     * @param recipient        Address that receives the tokens.
     * @param amount           Token amount in smallest units (e.g. 50000 for 0.05 USDC).
     * @param nonce            Unique per-owner nonce for replay protection.
     * @param deadline         Unix timestamp after which the signature is invalid.
     * @param witnessSignature EIP-712 signature produced by the user's wallet.
     */
    function transferWithAuthorization(
        address owner,
        address facilitator,
        address token,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata witnessSignature
    ) external {
        // 0. Facilitator check — only the designated facilitator may execute
        if (msg.sender != facilitator) revert UnauthorizedFacilitator();

        // 0b. Owner binding — under EIP-7702, address(this) must equal the signing owner
        if (owner == address(0)) revert InvalidOwner();
        if (owner != address(this)) revert OwnerMismatch();

        // 1. Time check
        if (block.timestamp > deadline) revert SignatureExpired();

        // 2. Replay protection
        if (usedNonces[owner][nonce]) revert NonceAlreadyUsed();

        // 3. Build EIP-712 digest
        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_AUTHORIZATION_TYPEHASH,
            owner,
            facilitator,
            token,
            recipient,
            amount,
            nonce,
            deadline
        ));

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            _domainSeparator(),
            structHash
        ));

        // 4. Recover signer and verify
        address recovered = _recoverSigner(digest, witnessSignature);
        if (recovered != owner) revert InvalidSignature();

        // 5. Mark nonce used
        usedNonces[owner][nonce] = true;

        // 6. Execute transfer
        //    In EIP-7702 context: address(this) == owner's EOA.
        //    msg.sender to USDC will be the user's EOA → direct balance debit.
        bool success = IERC20(token).transfer(recipient, amount);
        if (!success) revert TransferFailed();

        emit TransferExecuted(owner, facilitator, token, recipient, amount, nonce);
    }

    /**
     * @notice Permit2-mode: gasless transfer using pre-approved allowance.
     * @dev Fallback for chains without EIP-7702 support.
     *      User calls approve(thisContract, amount) once off-chain,
     *      then Facilitator calls this to execute the transfer.
     *      Domain verifyingContract = address(this) (the implementation contract).
     */
    function transferFromWithAuthorization(
        address owner,
        address facilitator,
        address token,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata witnessSignature
    ) external {
        // 0. Facilitator check — only the designated facilitator may execute
        if (msg.sender != facilitator) revert UnauthorizedFacilitator();

        if (block.timestamp > deadline) revert SignatureExpired();
        if (usedNonces[owner][nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_AUTHORIZATION_TYPEHASH,
            owner,
            facilitator,
            token,
            recipient,
            amount,
            nonce,
            deadline
        ));

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            _domainSeparator(),
            structHash
        ));

        address recovered = _recoverSigner(digest, witnessSignature);
        if (recovered != owner) revert InvalidSignature();

        usedNonces[owner][nonce] = true;

        // Uses transferFrom — requires prior approve(implContract, amount) by owner
        bool success = IERC20(token).transferFrom(owner, recipient, amount);
        if (!success) revert TransferFailed();

        emit TransferExecuted(owner, facilitator, token, recipient, amount, nonce);
    }

    // ─── View Helpers ─────────────────────────────────────────────────────────

    /**
     * @notice Returns the EIP-712 domain separator for this chain.
     * @dev Uses `address(this)` — under EIP-7702 delegation this equals the
     *      user's EOA, making the signature bound to a specific user.
     * @dev WARNING: Under EIP-7702 delegated execution, `address(this)` is the
     *      user's EOA, NOT the implementation contract address. Do NOT call this
     *      helper from a normal (non-delegated) context and expect the same value
     *      as during EIP-7702 execution — the verifyingContract will differ.
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    /**
     * @notice Compute the EIP-712 digest for off-chain pre-verification.
     * @dev WARNING: Under EIP-7702 delegated execution, `address(this)` is the
     *      user's EOA. Calling this from a non-delegated context (e.g., a script
     *      targeting the implementation address directly) will produce a different
     *      digest than what the user actually signs. Always call via the user's EOA.
     */
    function hashTransferAuthorization(
        address owner,
        address facilitator,
        address token,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_AUTHORIZATION_TYPEHASH,
            owner,
            facilitator,
            token,
            recipient,
            amount,
            nonce,
            deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            block.chainid,
            address(this)
        ));
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();

        // Reject high-s signatures to prevent ECDSA malleability
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
            revert InvalidSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}

// ─── Minimal ERC-20 Interface ─────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}
