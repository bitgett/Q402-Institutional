// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402PaymentImplementationScroll
 * @notice EIP-7702 Delegated Gasless Payment Implementation — Scroll Network
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
 *  EIP-712 domain name : "Q402 Scroll"
 *  Witness type        : TransferAuthorization
 *  Chain ID (Mainnet)  : 534352
 *  Native gas token    : ETH
 *
 *  Scroll-specific notes:
 *  - EIP-7702 fully supported via the Euclid upgrade: Phase 1 activated on
 *    Scroll mainnet 2025-04-16 (epoch ts 1744815600), Phase 2 on 2025-04-22
 *    (epoch ts 1745305200). Set-code transactions (type 0x04) are accepted
 *    by Scroll sequencers and finalized through the same prover stack as
 *    every other Scroll tx — no special handling on the relayer side.
 *  - Scroll is a zkEVM with byte-level EVM equivalence post-Euclid: the
 *    DOMAIN_TYPEHASH / TRANSFER_AUTHORIZATION_TYPEHASH and ecrecover are
 *    bit-identical to Ethereum mainnet, so a signature produced for
 *    "Q402 Scroll" verifies the same way the Avalanche / BNB / Monad
 *    variants verify on their respective chains.
 *  - USDC on Scroll is native Circle USDC (CCTP), USDT is Tether's
 *    canonical Scroll deployment — both are standard 6-decimal ERC-20s
 *    that accept IERC20.transfer from a delegated EOA. No reserve-balance
 *    or restricted-recipient rules to work around (unlike Monad's 10-MON
 *    floor).
 */
contract Q402PaymentImplementationScroll {

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

    string public constant NAME    = "Q402 Scroll";
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

    // ─── Core Function ────────────────────────────────────────────────────────

    /**
     * @notice Execute a gasless ERC-20 transfer via EIP-7702 delegation.
     *
     * @dev Called by the Facilitator (who pays ETH gas) after setting the
     *      EIP-7702 delegation on the user's EOA.
     *      Under EIP-7702: `address(this)` == user's EOA, so IERC20.transfer()
     *      sends tokens directly from the user's balance without allowance.
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

        bool success = IERC20(token).transfer(recipient, amount);
        if (!success) revert TransferFailed();

        emit TransferExecuted(owner, facilitator, token, recipient, amount, nonce);
    }

    /**
     * @notice Permit2-mode: gasless transfer using pre-approved allowance.
     * @dev Fallback for chains without EIP-7702 support.
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

        bool success = IERC20(token).transferFrom(owner, recipient, amount);
        if (!success) revert TransferFailed();

        emit TransferExecuted(owner, facilitator, token, recipient, amount, nonce);
    }

    // ─── View Helpers ─────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

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
        require(v == 27 || v == 28, "Q402: invalid v");
        return ecrecover(digest, v, r, s);
    }
}

// ─── Minimal ERC-20 Interface ─────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}
