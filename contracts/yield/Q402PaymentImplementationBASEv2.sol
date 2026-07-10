// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402PaymentImplementationBASEv2
 * @notice EIP-7702 delegated impl for Base mainnet (chainId 8453) — gasless ERC-20
 *         transfers (v1, preserved) PLUS gasless Morpho / ERC-4626 vault deposit +
 *         withdraw (v2, Q402 Yield). Modeled byte-for-byte on the audited BNB v2
 *         (Aave) impl; the vault path is ERC-4626 instead of Aave-Pool.
 *
 * @dev Agent Wallets delegate (EIP-7702) to a SINGLE impl, so the yield functions
 *      live here alongside transferWithAuthorization rather than in a separate impl
 *      (a second delegation target would be mutually exclusive with payments — see
 *      docs/yield-executor-spec.md §10). A Base wallet delegated to the payment-only
 *      impl (0x2fb2B2D110b6c5664e701666B3741240242bf350) re-delegates here to deposit,
 *      and keeps the ability to pay because transferWithAuthorization is preserved.
 *
 *  STORAGE COMPATIBILITY (CRITICAL — re-delegation safety):
 *    `usedNonces` MUST remain slot 0 (byte-identical to the deployed Base payment
 *    impl) so a wallet re-delegating from it carries its used-nonce set forward.
 *    New state is APPENDED only (`_reentrancyStatus` at slot 1). Never insert before
 *    `usedNonces`. Diff `forge inspect storage-layout` against the deployed Base
 *    payment impl before shipping.
 *
 *  BEFORE DEPLOY (do NOT skip — this is a mainnet, fund-moving contract):
 *    - Reconcile transferWithAuthorization + the domain ("Q402 Base") byte-for-byte
 *      against the ACTUAL deployed Base payment impl (0x2fb2…f350, BaseScan-verified).
 *      The deployed impl is the source of truth; match it exactly so existing payment
 *      witnesses verify identically and the shared nonce set stays consistent.
 *    - Independent adversarial audit (the vault path adds external-DeFi + approve surface).
 *    - Verify the curated vault's ERC-4626 interface + that asset() == BASE_USDC on
 *      the live Base proxy, and that BASE_USDC_VAULT here EQUALS the off-chain
 *      MORPHO_VAULT_BASE_USDC / MORPHO_DEFAULT_VAULT.base (drift guard).
 *
 *  EIP-712 domain name : "Q402 Base"   |  version "1"
 *  Witnesses           : TransferAuthorization, Erc4626SupplyAuthorization,
 *                        Erc4626WithdrawAuthorization (distinct typehashes block
 *                        cross-action replay).
 *  Under EIP-7702 delegation `address(this)` == the owner EOA.
 */
contract Q402PaymentImplementationBASEv2 {

    // ─── EIP-712 type hashes ────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant TRANSFER_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // Vault-bound (not pool-bound): the signed `vault` replaces Aave's `pool`.
    bytes32 public constant ERC4626_SUPPLY_AUTHORIZATION_TYPEHASH = keccak256(
        "Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 minSharesOut,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant ERC4626_WITHDRAW_AUTHORIZATION_TYPEHASH = keccak256(
        "Erc4626WithdrawAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 minAssetsOut,uint256 maxSharesBurned,uint256 nonce,uint256 deadline)"
    );

    string public constant NAME    = "Q402 Base";
    string public constant VERSION = "1";

    /// @notice Impl version tag — lets the SDK detect this build and prompt re-delegation.
    string public constant IMPL_VERSION = "4-yield-base-erc4626-slippage-measured";

    // ─── ERC-4626 vault allowlist (Base, immutable — spec §9.1 model A) ───────
    // Never trust the signed `vault`/`asset` unchecked: a compromised / prompt-
    // injected agent signer could otherwise approve+drain to a malicious vault.
    // BASE_USDC_VAULT is the single curated Base USDC MetaMorpho vault (Gauntlet
    // USDC Prime). It MUST equal the off-chain MORPHO_DEFAULT_VAULT.base /
    // MORPHO_VAULT_BASE_USDC; a drift guard enforces that off-chain.

    address internal constant BASE_USDC_VAULT = 0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61;
    address internal constant USDC            = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // native Circle USDC, 6dp

    function isAllowedVault(address vault) public pure returns (bool) { return vault == BASE_USDC_VAULT; }
    function isAllowedAsset(address asset) public pure returns (bool) { return asset == USDC; }

    // ─── State ──────────────────────────────────────────────────────────────
    // slot 0 — preserved (byte-identical to the deployed Base payment impl).
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    // slot 1 — APPENDED. 7702 leaves this 0 (no constructor runs on the EOA), so
    // the guard treats any value != _ENTERED as "not entered".
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
    event Erc4626Supplied(
        address indexed owner, address indexed vault, address indexed asset,
        uint256 assets, uint256 shares, uint256 nonce
    );
    event Erc4626Withdrawn(
        address indexed owner, address indexed vault, address indexed asset,
        uint256 assets, bool max, uint256 nonce
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error SignatureExpired();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error TransferFailed();
    error InvalidSignatureLength();
    error UnauthorizedFacilitator();
    error OwnerMismatch();
    error InvalidOwner();
    error BadAmount();
    error VaultNotAllowed();
    error AssetNotAllowed();
    error AssetVaultMismatch();
    error ApproveFailed();
    error NothingToWithdraw();
    error SlippageExceeded();

    // ─── v1: gasless ERC-20 transfer (preserved, payments) ───────────────────

    function transferWithAuthorization(
        address owner, address facilitator, address token, address recipient,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external {
        // RECONCILE byte-for-byte with the deployed Base payment impl before deploy.
        if (msg.sender != facilitator) revert UnauthorizedFacilitator();
        if (owner == address(0)) revert InvalidOwner();
        if (owner != address(this)) revert OwnerMismatch();
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

    // ─── v2: gasless ERC-4626 deposit ────────────────────────────────────────

    /**
     * @notice Deposit `asset` from the owner EOA into the ERC-4626 vault, gasless.
     * @dev Under 7702, address(this) == owner EOA. We approve exactly `amount` of
     *      `asset` to the vault and call deposit(amount, owner), minting shares to
     *      the owner. The facilitator submits the type-4 tx and pays gas.
     */
    function supplyToErc4626(
        address owner, address facilitator, address vault, address asset,
        uint256 amount, uint256 minSharesOut, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant returns (uint256 shares) {
        if (msg.sender != facilitator)                  revert UnauthorizedFacilitator();
        if (owner != address(this))                     revert OwnerMismatch();
        if (block.timestamp > deadline)                 revert SignatureExpired();
        if (amount == 0 || amount == type(uint256).max) revert BadAmount();
        if (!isAllowedVault(vault))                     revert VaultNotAllowed();
        if (!isAllowedAsset(asset))                     revert AssetNotAllowed();
        if (usedNonces[owner][nonce])                   revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            ERC4626_SUPPLY_AUTHORIZATION_TYPEHASH,
            owner, facilitator, vault, asset, amount, minSharesOut, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        // Defense in depth: the vault's underlying MUST be the signed asset, else the
        // approval would target the wrong token and deposit would pull a mismatch.
        if (IERC4626(vault).asset() != asset) revert AssetVaultMismatch();

        usedNonces[owner][nonce] = true;            // CEI: effects before interactions

        uint256 sharesBefore = IERC20(vault).balanceOf(owner);
        _setApproval(asset, vault, amount);         // exact-amount, reset-to-zero safe
        IERC4626(vault).deposit(amount, owner);
        _setApproval(asset, vault, 0);              // zero any residual allowance (defense in depth)

        // Slippage floor enforced on the OBSERVED share delta, not the vault's return
        // value: a non-conforming or upgraded allowlisted vault cannot satisfy the bound
        // while minting fewer shares to the owner (MD-01 / L-002).
        shares = IERC20(vault).balanceOf(owner) - sharesBefore;
        if (shares < minSharesOut) revert SlippageExceeded();

        emit Erc4626Supplied(owner, vault, asset, amount, shares, nonce);
    }

    // ─── v2: gasless ERC-4626 withdraw ───────────────────────────────────────

    /**
     * @notice Withdraw from the ERC-4626 vault back to the owner EOA, gasless.
     *         `amount == type(uint256).max` redeems the MAXIMUM CURRENTLY REDEEMABLE
     *         shares (maxRedeem), which vault caps, queues or pauses can leave below
     *         the owner's full share balance. Shares may remain outstanding after the
     *         call. A concrete `amount` withdraws that many underlying assets.
     * @dev ERC-4626 `withdraw` takes ASSETS and `redeem` takes SHARES; the max path
     *      uses redeem(maxRedeem) so it never over-asks and share rounding leaves no
     *      dust. This is a "withdraw max currently redeemable", NOT a guaranteed full
     *      exit: draining a position that a cap or queue is throttling needs a repeated
     *      or queued withdrawal. No approval needed: the vault burns the owner's shares
     *      (msg.sender == address(this) == owner).
     */
    function withdrawFromErc4626(
        address owner, address facilitator, address vault, address asset,
        uint256 amount, uint256 minAssetsOut, uint256 maxSharesBurned, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant returns (uint256 assetsOut) {
        if (msg.sender != facilitator)  revert UnauthorizedFacilitator();
        if (owner != address(this))     revert OwnerMismatch();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (amount == 0)                revert BadAmount();   // max sentinel IS allowed (max-redeemable)
        if (!isAllowedVault(vault))     revert VaultNotAllowed();
        if (!isAllowedAsset(asset))     revert AssetNotAllowed();
        if (usedNonces[owner][nonce])   revert NonceAlreadyUsed();

        {
            // scoped so structHash/digest free their stack slots before redeem/withdraw
            bytes32 structHash = keccak256(abi.encode(
                ERC4626_WITHDRAW_AUTHORIZATION_TYPEHASH,
                owner, facilitator, vault, asset, amount, minAssetsOut, maxSharesBurned, nonce, deadline
            ));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
            if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();
        }

        // Symmetry with supply: the vault's underlying MUST be the signed asset, so
        // the measured asset delta and the emitted `asset` can't be mislabeled once
        // the Base allowlist grows beyond a single vault (defense in depth).
        if (IERC4626(vault).asset() != asset) revert AssetVaultMismatch();

        usedNonces[owner][nonce] = true;

        // `amount == max` redeems the max CURRENTLY REDEEMABLE shares (maxRedeem),
        // which can be < the full balance under vault caps/queues (L-01). Bounds are
        // enforced on OBSERVED balance deltas below, never on the vault's return values.
        bool isMax = amount == type(uint256).max;
        uint256 assetBefore = IERC20(asset).balanceOf(owner);
        uint256 shareBefore = IERC20(vault).balanceOf(owner);
        if (isMax) {
            uint256 redeemable = IERC4626(vault).maxRedeem(owner);
            if (redeemable == 0) revert NothingToWithdraw();
            IERC4626(vault).redeem(redeemable, owner, owner);
        } else {
            IERC4626(vault).withdraw(amount, owner, owner); // reverts if assets exceed position
        }

        // Enforce the signed bounds on measured deltas, not on what the vault reports:
        // a non-conforming / upgraded allowlisted vault cannot burn more shares or
        // deliver fewer assets than the signed intent allows while still passing, and
        // the emitted `assetsOut` is the real payout (L-01 / MD-01 / L-002). nonReentrant
        // + the single external call make the deltas exact.
        uint256 sharesBurned = shareBefore - IERC20(vault).balanceOf(owner);
        if (sharesBurned > maxSharesBurned) revert SlippageExceeded();
        assetsOut = IERC20(asset).balanceOf(owner) - assetBefore;
        if (assetsOut < minAssetsOut) revert SlippageExceeded();

        emit Erc4626Withdrawn(owner, vault, asset, assetsOut, isMax, nonce);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) { return _domainSeparator(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /**
     * @dev Exact-amount approval, tolerant of tokens that revert on approve-to-
     *      nonzero-while-nonzero (reset to 0 first) and that return no boolean.
     *      Never sets an unlimited allowance. Base USDC returns bool cleanly; the
     *      tolerant path is kept for safety / future assets.
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
        if (v != 27 && v != 28) revert InvalidSignature();
        // reject high-s malleable signatures (same bound as the deployed impls)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function maxRedeem(address owner) external view returns (uint256 maxShares);
    function balanceOf(address account) external view returns (uint256);
}
