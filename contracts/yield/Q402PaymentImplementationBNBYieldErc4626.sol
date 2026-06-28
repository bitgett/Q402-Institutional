// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402PaymentImplementationBNBYieldErc4626
 * @notice EIP-7702 delegated impl for BNB Chain (chainId 56) — gasless ERC-20
 *         transfers (v1, preserved) PLUS gasless ERC-4626 vault deposit + withdraw
 *         into Lista Lending (Moolah curated "MoolahVault" vaults). This is the
 *         ERC-4626 sibling of the Aave-based BNB yield impl (Q402PaymentImplementationBNBv2):
 *         same EIP-7702 witness scheme, vault path instead of Aave-Pool.
 *
 * @dev Agent Wallets delegate (EIP-7702) to a SINGLE impl, so the yield functions
 *      live here alongside transferWithAuthorization (a second delegation target
 *      would be mutually exclusive with payments — see docs/yield-executor-spec.md §10).
 *      A BNB wallet delegated to the payment-only impl
 *      (0x6cF4aD62C208b6494a55a1494D497713ba013dFa) re-delegates here to deposit
 *      and keeps the ability to pay because transferWithAuthorization is preserved.
 *
 *  STORAGE COMPATIBILITY (CRITICAL — re-delegation safety):
 *    `usedNonces` MUST remain slot 0 (byte-identical to the deployed BNB payment
 *    impl, BscScan-verified 0x6cF4aD62…) so a wallet re-delegating from it carries
 *    its used-nonce set forward. New state is APPENDED only (`_reentrancyStatus` at
 *    slot 1). Never insert before `usedNonces`. Diff `forge inspect storage-layout`
 *    against the deployed BNB payment impl before shipping.
 *
 *  BEFORE DEPLOY (do NOT skip — this is a mainnet, fund-moving contract):
 *    - Reconcile transferWithAuthorization + the domain ("Q402 BNB Chain") against the
 *      deployed BNB payment impl (0x6cF4aD62…): match its transferWithAuthorization guard
 *      set / typehash / digest / high-s bound EXACTLY so existing payment witnesses verify
 *      identically and the shared nonce set stays consistent. NOTE the deployed impl's
 *      Permit2 `transferFromWithAuthorization` and the `hashTransferAuthorization` view are
 *      intentionally OMITTED here (7702-only impl, matching the v2 yield line) — confirm no
 *      live flow calls them while a wallet is yield-delegated.
 *    - Independent adversarial audit (the vault path adds external-DeFi + approve surface).
 *    - Verify each curated vault's ERC-4626 interface + that asset() == the allowlisted
 *      stablecoin on the LIVE BNB proxy, and that LISTA_USDT_VAULT here EQUALS the
 *      off-chain listaVaultFor(bnb,"USDT") default (drift guard:
 *      __tests__/yield-bnb-lista-vault-drift.test.ts).
 *    - CONFIRM the routing vault(s) with Lista before deploy (Gauntlet USDT Vault is
 *      the launch default; a USDC vault is added once Lista provides its address).
 *
 *  EIP-712 domain name : "Q402 BNB Chain"   |  version "1"
 *  Witnesses           : TransferAuthorization, Erc4626SupplyAuthorization,
 *                        Erc4626WithdrawAuthorization (distinct typehashes block
 *                        cross-action replay).
 *  Under EIP-7702 delegation `address(this)` == the owner EOA.
 */
contract Q402PaymentImplementationBNBYieldErc4626 {

    // ─── EIP-712 type hashes ────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant TRANSFER_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferAuthorization(address owner,address facilitator,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // Vault-bound (not pool-bound): the signed `vault` is the ERC-4626 MoolahVault.
    bytes32 public constant ERC4626_SUPPLY_AUTHORIZATION_TYPEHASH = keccak256(
        "Erc4626SupplyAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant ERC4626_WITHDRAW_AUTHORIZATION_TYPEHASH = keccak256(
        "Erc4626WithdrawAuthorization(address owner,address facilitator,address vault,address asset,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    string public constant NAME    = "Q402 BNB Chain";
    string public constant VERSION = "1";

    /// @notice Impl version tag — lets the SDK detect this build and prompt re-delegation.
    string public constant IMPL_VERSION = "2-yield-bnb-erc4626-lista";

    // ─── ERC-4626 vault allowlist (BNB / Lista, immutable — spec §9.1 model A) ─
    // Never trust the signed `vault`/`asset` unchecked: a compromised / prompt-
    // injected agent signer could otherwise approve+drain to a malicious vault.
    //
    // Both vaults verified on BNB mainnet (ERC-4626, asset() == the allowlisted
    // stablecoin). Each MUST equal the off-chain listaVaultFor(bnb,<asset>) default;
    // a drift guard enforces that off-chain. BSC USDT/USDC are 18-decimals (not 6),
    // and BSC USDT has no EIP-2612 permit, so the approve runs on-chain (relayer
    // pays) — see _setApproval. The AssetVaultMismatch check (asset() == asset) makes
    // USDT route only to the USDT vault and USDC only to the USDC vault (no crossing).
    //   LISTA_USDT_VAULT = Gauntlet USDT Vault   (asset BSC USDT, ~$8M)
    //   LISTA_USDC_VAULT = Lista USDC Vault/lisUSDC (asset BSC USDC, ~$330K)

    address internal constant LISTA_USDT_VAULT = 0x6d6783C146F2B0B2774C1725297f1845dc502525; // Gauntlet USDT Vault
    address internal constant LISTA_USDC_VAULT = 0x8a06Ac91265dBEBE6D4606f45b10993E9a571869; // Lista USDC Vault (lisUSDC)
    address internal constant USDT             = 0x55d398326f99059fF775485246999027B3197955; // BSC USDT, 18dp, no permit
    address internal constant USDC             = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d; // BSC USDC, 18dp

    function isAllowedVault(address vault) public pure returns (bool) { return vault == LISTA_USDT_VAULT || vault == LISTA_USDC_VAULT; }
    function isAllowedAsset(address asset) public pure returns (bool) { return asset == USDT || asset == USDC; }

    // ─── State ──────────────────────────────────────────────────────────────
    // slot 0 — preserved (byte-identical to the deployed BNB payment impl).
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

    // ─── v1: gasless ERC-20 transfer (preserved, payments) ───────────────────

    function transferWithAuthorization(
        address owner, address facilitator, address token, address recipient,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external {
        // Core transfer path matches the DEPLOYED BNB v1 impl's transferWithAuthorization
        // (BscScan-verified 0x6cF4aD62C208b6494a55a1494D497713ba013dFa): same guard set,
        // typehash, digest and high-s bound, so existing payment witnesses verify
        // identically and the shared usedNonces (slot 0) stays consistent. The deployed
        // impl's Permit2 transferFromWithAuthorization + the hashTransferAuthorization view
        // are intentionally OMITTED (7702-only, like the v2 yield line). ERC-4626 fns below are new.
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
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant returns (uint256 shares) {
        if (msg.sender != facilitator)                  revert UnauthorizedFacilitator();
        if (owner == address(0))                        revert InvalidOwner();
        if (owner != address(this))                     revert OwnerMismatch();
        if (block.timestamp > deadline)                 revert SignatureExpired();
        if (amount == 0 || amount == type(uint256).max) revert BadAmount();
        if (!isAllowedVault(vault))                     revert VaultNotAllowed();
        if (!isAllowedAsset(asset))                     revert AssetNotAllowed();
        if (usedNonces[owner][nonce])                   revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            ERC4626_SUPPLY_AUTHORIZATION_TYPEHASH,
            owner, facilitator, vault, asset, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        // Defense in depth: the vault's underlying MUST be the signed asset, else the
        // approval would target the wrong token and deposit would pull a mismatch.
        // (Also blocks routing USDT into a USDC vault once a USDC vault is allowlisted.)
        if (IERC4626(vault).asset() != asset) revert AssetVaultMismatch();

        usedNonces[owner][nonce] = true;            // CEI: effects before interactions

        _setApproval(asset, vault, amount);         // exact-amount, reset-to-zero safe
        shares = IERC4626(vault).deposit(amount, owner);
        _setApproval(asset, vault, 0);              // zero any residual allowance (defense in depth)

        emit Erc4626Supplied(owner, vault, asset, amount, shares, nonce);
    }

    // ─── v2: gasless ERC-4626 withdraw ───────────────────────────────────────

    /**
     * @notice Withdraw from the ERC-4626 vault back to the owner EOA, gasless.
     *         `amount == type(uint256).max` redeems the FULL share balance
     *         (maxRedeem). A concrete `amount` withdraws that many underlying assets.
     * @dev ERC-4626 `withdraw` takes ASSETS and `redeem` takes SHARES. Full-drain
     *      MUST be redeem(maxRedeem) — withdraw(uint.max assets) is NOT a withdraw-all
     *      idiom and share rounding would leave dust. No approval needed: the vault
     *      burns the owner's shares (msg.sender == address(this) == owner).
     */
    function withdrawFromErc4626(
        address owner, address facilitator, address vault, address asset,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant returns (uint256 assetsOut) {
        if (msg.sender != facilitator)  revert UnauthorizedFacilitator();
        if (owner == address(0))        revert InvalidOwner();
        if (owner != address(this))     revert OwnerMismatch();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (amount == 0)                revert BadAmount();   // max IS allowed (withdraw-all)
        if (!isAllowedVault(vault))     revert VaultNotAllowed();
        if (!isAllowedAsset(asset))     revert AssetNotAllowed();
        if (usedNonces[owner][nonce])   revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            ERC4626_WITHDRAW_AUTHORIZATION_TYPEHASH,
            owner, facilitator, vault, asset, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        // Symmetry with supply (L198): the vault's underlying MUST be the signed
        // asset, so the emitted `asset` + any downstream accounting can't be
        // mislabeled (e.g. a USDT-vault withdraw signed with asset=USDC).
        if (IERC4626(vault).asset() != asset) revert AssetVaultMismatch();

        usedNonces[owner][nonce] = true;

        bool isMax = amount == type(uint256).max;
        if (isMax) {
            uint256 shares = IERC4626(vault).maxRedeem(owner);
            if (shares == 0) revert NothingToWithdraw();
            assetsOut = IERC4626(vault).redeem(shares, owner, owner);
        } else {
            // Measure the underlying actually received (balance delta) rather than
            // trusting `amount`, so a non-compliant / fee-charging vault cannot make
            // the Erc4626Withdrawn event over-report the payout. nonReentrant + the
            // single external call make the delta exact.
            uint256 balBefore = IERC20(asset).balanceOf(owner);
            IERC4626(vault).withdraw(amount, owner, owner); // reverts if assets exceed position
            assetsOut = IERC20(asset).balanceOf(owner) - balBefore;
        }

        emit Erc4626Withdrawn(owner, vault, asset, assetsOut, isMax, nonce);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) { return _domainSeparator(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /**
     * @dev Exact-amount approval, tolerant of USDT-class tokens that (a) revert on
     *      approve-to-nonzero-while-nonzero (reset to 0 first) and (b) return no
     *      boolean. Never sets an unlimited allowance. BSC USDT has no EIP-2612
     *      permit, so this on-chain approve is required (relayer pays).
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
