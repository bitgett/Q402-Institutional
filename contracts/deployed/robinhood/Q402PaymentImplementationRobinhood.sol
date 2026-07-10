// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402PaymentImplementationRobinhood
 * @notice EIP-7702 Delegated Gasless Payment Implementation — Robinhood Chain
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
 *  EIP-712 domain name : "Q402 Robinhood Chain"
 *  Witness type        : TransferAuthorization
 *  Chain ID (Mainnet)  : 4663
 *  Native gas token    : ETH
 *
 *  Robinhood Chain notes (Arbitrum Nitro L2, ArbOS 61):
 *  - EIP-7702 is supported: ArbOS 61 is well past the ArbOS 40 "Callisto"
 *    threshold that introduced EIP-7702, and Robinhood's account-abstraction
 *    docs advertise it. Set-code transactions (type 0x04) finalize through the
 *    standard Nitro stack; no chain-specific handling on the relayer side.
 *  - Nitro is byte-level EVM-equivalent: DOMAIN_TYPEHASH /
 *    TRANSFER_AUTHORIZATION_TYPEHASH and ecrecover are bit-identical to
 *    Ethereum, so a signature for "Q402 Robinhood Chain" verifies the same way
 *    the other Q402 chain variants verify on theirs.
 *  - Settlement stablecoins are USDG (Paxos Global Dollar, 6 decimals,
 *    0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) and USDe (Ethena, 18 decimals,
 *    0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34). There is NO native Circle
 *    USDC / Tether USDT on this chain; on-chain "USDC"/"USDT" tokens are
 *    mock/scam, and even USDG has 5+ spoofed copies -- Q402 allowlists by
 *    ADDRESS, never by symbol. USDe is 18 decimals (parseUnits, never parseFloat).
 *  - Native gas is ETH; the relayer / gas-tank holds ETH on chainId 4663 (no
 *    stablecoin-gas shortcut). maxPriorityFeePerGas may be 0 (FCFS sequencing).
 */
contract Q402PaymentImplementationRobinhood {

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

    string public constant NAME    = "Q402 Robinhood Chain";
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
    error UnauthorizedFacilitator();
    error InvalidOwner();
    error OwnerMismatch();

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
        // 0. Facilitator check — only the designated facilitator may execute
        if (msg.sender != facilitator) revert UnauthorizedFacilitator();

        // 0b. Owner binding — under EIP-7702, address(this) IS the signing owner's
        //     EOA, so the funds moved by IERC20.transfer() below leave that EOA.
        //     Binding owner == address(this) forces the caller to present the
        //     account holder's own signature; without it anyone could drain any
        //     delegated account with a signature over their own `owner` value.
        if (owner == address(0)) revert InvalidOwner();
        if (owner != address(this)) revert OwnerMismatch();

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
        // Facilitator check — only the designated facilitator may execute.
        // Permit2/allowance mode pulls from `owner` (not address(this)), so the
        // owner==address(this) binding does not apply here; the hardened
        // _recoverSigner (rejects signer==address(0)) blocks the zero-owner path.
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
