// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402PaymentImplementationBNBv2
 * @notice EIP-7702 delegated impl for BNB Chain — gasless ERC-20 transfers
 *         (v1, preserved) PLUS gasless Aave V3 supply / withdraw (v2, Q402 Yield).
 *
 * @dev This is a v2 of the BNB payment implementation. Agent Wallets delegate
 *      (EIP-7702) to a SINGLE impl, so the Aave functions are added here rather
 *      than to a separate impl (a second delegation target would be mutually
 *      exclusive with payments — see docs/yield-executor-spec.md §10).
 *
 *  STORAGE COMPATIBILITY (CRITICAL — re-delegation safety):
 *    `usedNonces` MUST remain slot 0 (byte-identical to v1) so wallets that
 *    re-delegate from v1 carry their used-nonce set forward. New state is
 *    APPENDED only (`_reentrancyStatus` at slot 1). Never insert before
 *    `usedNonces`. Diff `forge inspect storage-layout` against the deployed v1
 *    before shipping.
 *
 *  BEFORE DEPLOY:
 *    - Reconcile this file against the ACTUAL deployed BNB impl source (the
 *      canonical/deployed contract is the source of truth; this draft mirrors
 *      the documented witness scheme but the deployed impl may differ in
 *      details such as the msg.sender==facilitator check). Match it exactly.
 *    - Independent audit (the Aave functions add external-DeFi + approve surface).
 *    - Verify Aave V3 BNB Pool supply/withdraw signatures against the live proxy.
 *
 *  EIP-712 domain name : "Q402 BNB Chain"   |  version "1"
 *  Witnesses           : TransferAuthorization, AaveSupplyAuthorization,
 *                        AaveWithdrawAuthorization (distinct typehashes block
 *                        cross-action replay).
 *  Under EIP-7702 delegation `address(this)` == the owner EOA.
 */
contract Q402PaymentImplementationBNBv2 {

    // ─── EIP-712 type hashes ────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant TRANSFER_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant AAVE_SUPPLY_AUTHORIZATION_TYPEHASH = keccak256(
        "AaveSupplyAuthorization(address owner,address facilitator,address pool,address asset,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant AAVE_WITHDRAW_AUTHORIZATION_TYPEHASH = keccak256(
        "AaveWithdrawAuthorization(address owner,address facilitator,address pool,address asset,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    string public constant NAME    = "Q402 BNB Chain";
    string public constant VERSION = "1";

    /// @notice Impl version tag — lets the SDK detect v2 and prompt re-delegation.
    string public constant IMPL_VERSION = "2-yield";

    // ─── Aave V3 allowlist (BNB Chain, immutable — spec §9.1 model A) ────────
    // Never trust the signed `pool`/`asset` unchecked: a compromised/prompt-
    // injected agent signer could otherwise approve+drain to a malicious pool.

    address internal constant AAVE_POOL = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address internal constant USDC      = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address internal constant USDT      = 0x55d398326f99059fF775485246999027B3197955;

    function isAllowedPool(address pool)  public pure returns (bool) { return pool == AAVE_POOL; }
    function isAllowedAsset(address asset) public pure returns (bool) { return asset == USDC || asset == USDT; }

    // ─── State ──────────────────────────────────────────────────────────────
    // slot 0 — preserved from v1 (byte-identical).
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    // slot 1 — APPENDED in v2. 7702 leaves this 0 (no constructor runs on the
    // EOA), so the guard treats any value != _ENTERED as "not entered".
    uint256 private _reentrancyStatus;
    uint256 private constant _ENTERED = 2;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "Q402: reentrant");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = 1;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event TransferExecuted(
        address indexed owner, address indexed facilitator, address indexed token,
        address recipient, uint256 amount, uint256 nonce
    );
    event AaveSupplied(
        address indexed owner, address indexed pool, address indexed asset,
        uint256 amount, uint256 nonce
    );
    event AaveWithdrawn(
        address indexed owner, address indexed pool, address indexed asset,
        uint256 amount, bool max, uint256 nonce
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error SignatureExpired();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error TransferFailed();
    error InvalidSignatureLength();
    error CallerNotFacilitator();
    error OwnerMismatch();
    error BadAmount();
    error PoolNotAllowed();
    error AssetNotAllowed();
    error ApproveFailed();

    // ─── v1: gasless ERC-20 transfer (preserved verbatim) ────────────────────

    function transferWithAuthorization(
        address owner, address facilitator, address token, address recipient,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (usedNonces[owner][nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_AUTHORIZATION_TYPEHASH,
            owner, facilitator, token, recipient, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        usedNonces[owner][nonce] = true;

        if (!IERC20(token).transfer(recipient, amount)) revert TransferFailed();
        emit TransferExecuted(owner, facilitator, token, recipient, amount, nonce);
    }

    // ─── v2: gasless Aave V3 supply ──────────────────────────────────────────

    /**
     * @notice Supply `asset` from the owner EOA into Aave V3, gasless.
     * @dev Under 7702, address(this) == owner EOA, so the Pool pulls `asset`
     *      from the owner and mints aTokens to the owner. The facilitator
     *      (relayer) submits the type-4 tx and pays gas.
     */
    function supplyToAave(
        address owner, address facilitator, address pool, address asset,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant {
        if (msg.sender != facilitator)               revert CallerNotFacilitator();
        if (owner != address(this))                  revert OwnerMismatch();
        if (block.timestamp > deadline)              revert SignatureExpired();
        if (amount == 0 || amount == type(uint256).max) revert BadAmount();
        if (!isAllowedPool(pool))                    revert PoolNotAllowed();
        if (!isAllowedAsset(asset))                  revert AssetNotAllowed();
        if (usedNonces[owner][nonce])                revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            AAVE_SUPPLY_AUTHORIZATION_TYPEHASH,
            owner, facilitator, pool, asset, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        usedNonces[owner][nonce] = true;          // CEI: effects before interactions

        _setApproval(asset, pool, amount);        // exact-amount, reset-to-zero safe
        IAaveV3Pool(pool).supply(asset, amount, owner, 0);

        emit AaveSupplied(owner, pool, asset, amount, nonce);
    }

    // ─── v2: gasless Aave V3 withdraw ────────────────────────────────────────

    /**
     * @notice Withdraw `asset` from Aave V3 back to the owner EOA, gasless.
     *         `amount == type(uint256).max` withdraws the full aToken balance.
     * @dev Burns the owner's aTokens (address(this) == owner holds them); no
     *      approval needed.
     */
    function withdrawFromAave(
        address owner, address facilitator, address pool, address asset,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant returns (uint256 withdrawn) {
        if (msg.sender != facilitator)  revert CallerNotFacilitator();
        if (owner != address(this))     revert OwnerMismatch();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (amount == 0)                revert BadAmount();   // max IS allowed (withdraw-all)
        if (!isAllowedPool(pool))       revert PoolNotAllowed();
        if (!isAllowedAsset(asset))     revert AssetNotAllowed();
        if (usedNonces[owner][nonce])   revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            AAVE_WITHDRAW_AUTHORIZATION_TYPEHASH,
            owner, facilitator, pool, asset, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        usedNonces[owner][nonce] = true;

        withdrawn = IAaveV3Pool(pool).withdraw(asset, amount, owner);
        emit AaveWithdrawn(owner, pool, asset, withdrawn, amount == type(uint256).max, nonce);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) { return _domainSeparator(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /**
     * @dev Exact-amount approval, tolerant of USDT-class tokens that (a) revert
     *      on approve-to-nonzero-while-nonzero (reset to 0 first) and (b) return
     *      no boolean. Never sets an unlimited allowance. BNB USDT has no
     *      EIP-2612 permit, so this on-chain approve is required (relayer pays).
     */
    function _setApproval(address token, address spender, uint256 target) internal {
        uint256 cur = IERC20(token).allowance(address(this), spender);
        if (cur == target) return;
        if (cur != 0) _safeApprove(token, spender, 0);
        if (target != 0) _safeApprove(token, spender, target);
    }

    function _safeApprove(address token, address spender, uint256 value) internal {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, value)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)),
            block.chainid, address(this)
        ));
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert InvalidSignatureLength();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Q402: invalid v");
        // reject high-s malleable signatures
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "Q402: bad s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "Q402: zero signer");
        return signer;
    }
}

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
