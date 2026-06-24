// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402StakingImplementationBNB
 * @notice EIP-7702 delegated impl for BNB Chain — gasless Q (QuackAI) token
 *         staking into the QuackAiStake contract, and unstaking.
 *
 * @dev A DEDICATED staking impl (not folded into the payment/yield impls) so the
 *      deployed transfer + Aave/Morpho impls are untouched and this contract's
 *      audit surface is minimal. EIP-7702 sets the EOA's code per-tx, so a wallet
 *      delegates HERE only for a stake/unstake tx; transfers/yield keep their own
 *      impls. Under 7702 `address(this)` == the owner EOA, so when this code calls
 *      `QuackAiStake.stake()`, the staking contract sees the OWNER as the staker
 *      (it pulls Q from the owner via the approval set here and records the
 *      position for the owner); `withdraw()` returns Q to the owner.
 *
 *  STORAGE COMPATIBILITY (CRITICAL): `usedNonces` is slot 0 + `_reentrancyStatus`
 *    slot 1 — byte-identical to the BNB payment/yield impls so a wallet that
 *    re-delegates between impls carries its used-nonce set forward and the EOA's
 *    persistent storage is interpreted consistently. Never insert before
 *    `usedNonces`; new state APPENDS only.
 *
 *  ALLOWLIST (immutable): the signed `stakeContract`/`token` are checked against
 *    the canonical QuackAiStake + Q addresses. A compromised/prompt-injected
 *    agent signer therefore cannot approve+drain Q to an arbitrary contract — the
 *    only reachable external call is `QuackAiStake.stake()` pulling the EXACT
 *    signed amount of Q.
 *
 *  BEFORE DEPLOY:
 *    - Independent adversarial audit (external-DeFi + approve surface).
 *    - Verify on-chain that QuackAiStake.stake(stakeType,amount) pulls `amount`
 *      Q via transferFrom (so the approval is required + sufficient) and that
 *      withdraw(amount) returns Q to msg.sender.
 *    - Compile solc 0.8.20 / optimizer 200 / evmVersion london (match the
 *      deployed BNB impls + the landing deploy script).
 *
 *  EIP-712 domain name : "Q402 BNB Chain"   |  version "1"
 *  Witnesses           : StakeAuthorization, UnstakeAuthorization (distinct
 *                        typehashes block cross-action replay; the shared
 *                        usedNonces set blocks replay across all BNB impls).
 */
contract Q402StakingImplementationBNB {

    // ─── EIP-712 type hashes ────────────────────────────────────────────────

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant STAKE_AUTHORIZATION_TYPEHASH = keccak256(
        "StakeAuthorization(address owner,address facilitator,address stakeContract,address token,uint256 stakeType,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant UNSTAKE_AUTHORIZATION_TYPEHASH = keccak256(
        "UnstakeAuthorization(address owner,address facilitator,address stakeContract,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    string public constant NAME    = "Q402 BNB Chain";
    string public constant VERSION = "1";

    /// @notice Impl version tag — lets the SDK detect the staking impl.
    string public constant IMPL_VERSION = "2-staking";

    // ─── Allowlist (BNB Chain, immutable) ────────────────────────────────────
    // Never trust the signed stakeContract/token unchecked.

    address internal constant QUACK_STAKE = 0x7D23C17cE1baFaD881582DaE54C386feE515E96b;
    address internal constant Q_TOKEN     = 0xc07e1300dc138601FA6B0b59f8D0FA477e690589;

    function isAllowedStake(address stakeContract) public pure returns (bool) { return stakeContract == QUACK_STAKE; }
    function isAllowedToken(address token) public pure returns (bool) { return token == Q_TOKEN; }

    // ─── State (layout shared with the BNB payment/yield impls) ──────────────
    // slot 0 — byte-identical to the deployed impls.
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    // slot 1 — APPENDED. 7702 leaves this 0 (no constructor runs on the EOA).
    uint256 private _reentrancyStatus;
    uint256 private constant _ENTERED = 2;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "Q402: reentrant");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = 1;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event Staked(
        address indexed owner, address indexed stakeContract,
        uint256 stakeType, uint256 amount, uint256 nonce
    );
    event Unstaked(
        address indexed owner, address indexed stakeContract,
        uint256 amount, uint256 nonce
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    error SignatureExpired();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error InvalidSignatureLength();
    error UnauthorizedFacilitator();
    error OwnerMismatch();
    error BadAmount();
    error StakeNotAllowed();
    error TokenNotAllowed();
    error ApproveFailed();
    error StakeAmountMismatch();

    // ─── Gasless Q stake ─────────────────────────────────────────────────────

    /**
     * @notice Stake `amount` Q from the owner EOA into QuackAiStake, gasless.
     * @dev Under 7702 address(this) == owner EOA; we approve EXACTLY `amount` of
     *      Q to the staking contract and call stake(stakeType, amount), which
     *      pulls the Q from the owner and records the position for the owner. The
     *      facilitator (relayer) submits the type-4 tx and pays gas. stakeType is
     *      validated by the staking contract (reverts on an unknown tier).
     */
    function stakeQuack(
        address owner, address facilitator, address stakeContract, address token,
        uint256 stakeType, uint256 amount, uint256 nonce, uint256 deadline,
        bytes calldata witnessSignature
    ) external nonReentrant {
        if (msg.sender != facilitator)               revert UnauthorizedFacilitator();
        if (owner != address(this))                  revert OwnerMismatch();
        if (block.timestamp > deadline)              revert SignatureExpired();
        if (amount == 0 || amount == type(uint256).max) revert BadAmount();
        if (!isAllowedStake(stakeContract))          revert StakeNotAllowed();
        if (!isAllowedToken(token))                  revert TokenNotAllowed();
        if (usedNonces[owner][nonce])                revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            STAKE_AUTHORIZATION_TYPEHASH,
            owner, facilitator, stakeContract, token, stakeType, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        usedNonces[owner][nonce] = true;          // CEI: effects before interactions

        // Enforce the load-bearing assumption that stake() actually pulls EXACTLY
        // `amount` Q from the owner. QuackAiStake's source isn't BscScan-verified,
        // so if it pulls nothing (records-only) or a different amount (fee-on-
        // transfer), we revert LOUDLY rather than burn the nonce on a no-op stake.
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        _setApproval(token, stakeContract, amount);   // exact-amount, reset-to-zero safe
        IQuackStake(stakeContract).stake(stakeType, amount);
        // Defensive: never leave a residual allowance to the staking contract.
        _setApproval(token, stakeContract, 0);
        // balBefore >= balAfter always (a stake can't increase the owner's Q).
        if (balBefore - IERC20(token).balanceOf(address(this)) != amount) revert StakeAmountMismatch();

        emit Staked(owner, stakeContract, stakeType, amount, nonce);
    }

    // ─── Gasless Q unstake (withdraw) ────────────────────────────────────────

    /**
     * @notice Withdraw `amount` Q from QuackAiStake back to the owner EOA, gasless.
     * @dev QuackAiStake.withdraw(amount) returns Q to msg.sender (== owner under
     *      7702); no approval needed. Lock-period / amount validity is enforced by
     *      the staking contract (reverts if locked or over-withdraw).
     */
    function unstakeQuack(
        address owner, address facilitator, address stakeContract,
        uint256 amount, uint256 nonce, uint256 deadline, bytes calldata witnessSignature
    ) external nonReentrant {
        if (msg.sender != facilitator)      revert UnauthorizedFacilitator();
        if (owner != address(this))         revert OwnerMismatch();
        if (block.timestamp > deadline)     revert SignatureExpired();
        if (amount == 0)                    revert BadAmount();
        if (!isAllowedStake(stakeContract)) revert StakeNotAllowed();
        if (usedNonces[owner][nonce])       revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            UNSTAKE_AUTHORIZATION_TYPEHASH,
            owner, facilitator, stakeContract, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        if (_recoverSigner(digest, witnessSignature) != owner) revert InvalidSignature();

        usedNonces[owner][nonce] = true;

        IQuackStake(stakeContract).withdraw(amount);
        emit Unstaked(owner, stakeContract, amount, nonce);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    function domainSeparator() external view returns (bytes32) { return _domainSeparator(); }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /**
     * @dev Exact-amount approval, tolerant of USDT-class tokens that (a) revert on
     *      approve-to-nonzero-while-nonzero (reset to 0 first) and (b) return no
     *      boolean. Never sets an unlimited allowance.
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
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IQuackStake {
    function stake(uint256 stakeType, uint256 amount) external;
    function withdraw(uint256 amount) external;
}
