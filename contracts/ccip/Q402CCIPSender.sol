// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402CCIPSender
 * @notice Cross-chain USDC bridge via Chainlink CCIP — source-side entrypoint.
 * @dev Phase-1 MVP design:
 *
 *  Architecture:
 *    Q402 server-managed Agentic Wallet (Mode C) calls bridge(...) on this
 *    contract directly. The Agentic Wallet has pre-approved this contract for
 *    USDC. This contract owns a LINK + native pool (topped up by the Q402
 *    facilitator) and uses it to pay the CCIP fee. The caller pays only USDC
 *    (amount being bridged); no LINK/native handling required client-side.
 *
 *  Why no EIP-712 / no EIP-7702 here:
 *    Mode A/B (user holds private key locally) is not supported in v1 — bridge
 *    is launched from the Mode C Agentic Wallet path only. Q402 server signs
 *    bridge() directly using the Agentic Wallet's key, so msg.sender == owner
 *    naturally. This avoids the EIP-7702 single-delegation conflict with the
 *    payment impl. v2 may add EIP-712 BridgeAuthorization for external EOAs.
 *
 *  Off-chain Gas Tank tracking:
 *    This contract pays the CCIP fee from its own pool. Per-user accounting
 *    (who owes what LINK or native) is tracked entirely in Q402's KV under
 *    the `gastank:{address}:{chain}:link` and `gastank:{address}:{chain}` keys.
 *    Server-side validation: balance >= fee before submitting the bridge TX.
 *    Conservation: sum of all KV credits ≤ contract balance at all times.
 *
 *  Receiver-side (Phase 1):
 *    CCIP delivers USDC to an EOA (the Agentic Wallet on the destination chain).
 *    No destination contract needed for token-only transfers. Phase 2 may add
 *    Q402CCIPReceiver for programmable settlement (USDC arrival + immediate
 *    Q402 payment to a vendor in one cross-chain action).
 *
 *  CCIP version: v1.6 (current mainnet) — Router interface matches the
 *  IRouterClient ABI at /api-reference/evm/v160.
 */

import "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract Q402CCIPSender {

    // ─── Immutables (per-chain hardwired at deploy) ──────────────────────────

    IRouterClient public immutable ROUTER;
    IERC20       public immutable LINK;
    IERC20       public immutable USDC;
    address      public immutable FACILITATOR;

    // ─── Fee-token enum ──────────────────────────────────────────────────────

    /// @notice feeToken=0 → LINK (10% CCIP discount). feeToken=1 → native gas token.
    uint8 public constant FEE_TOKEN_LINK   = 0;
    uint8 public constant FEE_TOKEN_NATIVE = 1;

    // ─── Events ──────────────────────────────────────────────────────────────

    event BridgeInitiated(
        bytes32 indexed messageId,
        address indexed owner,
        uint64  indexed destChainSelector,
        address         destReceiver,
        uint256         amount,
        uint8           feeToken,
        uint256         feePaid
    );

    event LinkPoolTopup(address indexed from, uint256 amount);
    event NativePoolTopup(address indexed from, uint256 amount);
    event PoolWithdraw(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error FeeExceedsMax();
    error InsufficientLinkPool();
    error InsufficientNativePool();
    error UnknownFeeToken();
    error OnlyFacilitator();
    error TransferFailed();
    error ZeroOwner();
    error RecipientNotOwner();

    modifier onlyFacilitator() {
        if (msg.sender != FACILITATOR) revert OnlyFacilitator();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address router, address link, address usdc, address facilitator) {
        ROUTER      = IRouterClient(router);
        LINK        = IERC20(link);
        USDC        = IERC20(usdc);
        FACILITATOR = facilitator;
        // Pre-approve Router for both LINK + USDC max — single-call gas savings
        // on every bridge. Safe: Router is an immutable Chainlink contract.
        LINK.approve(router, type(uint256).max);
        USDC.approve(router, type(uint256).max);
    }

    // ─── Core: bridge ────────────────────────────────────────────────────────

    /**
     * @notice Bridge an owner's USDC from this chain to a destination CCIP chain.
     * @dev onlyFacilitator. `owner` must have approved this contract for `amount`
     *      USDC; the Q402 relayer submits this call. Fee is paid from this
     *      contract's internal pool (LINK or native, per `feeToken`). Off-chain Gas
     *      Tank accounting is the Q402 server's responsibility.
     *
     * @param owner              the account whose USDC is bridged (pre-approved this contract)
     * @param destChainSelector  CCIP chainSelector of destination
     * @param amount             USDC amount (raw 6-decimal units)
     * @param destReceiver       Address to receive USDC on destination
     *                           chain — typically the user's Agentic
     *                           Wallet there (same EOA across chains)
     * @param feeToken           0 = LINK (cheaper), 1 = native
     * @param maxFee             Caller's max acceptable fee. Reverts if
     *                           live quote exceeds.
     * @return messageId         CCIP message id, traceable on
     *                           ccip.chain.link/msg/{messageId}
     */
    function bridgeFor(
        address owner,
        uint64  destChainSelector,
        uint256 amount,
        address destReceiver,
        uint8   feeToken,
        uint256 maxFee
    ) external onlyFacilitator returns (bytes32 messageId) {
        if (owner == address(0)) revert ZeroOwner();
        // Recipient is force-bound to the owner's own address on the destination
        // chain (mirrors Q402OftSender). Without this, a compromised FACILITATOR
        // could pull any approver's USDC and deliver it to a third party. The
        // "then pay someone" step is a separate destination-chain payment.
        if (destReceiver != owner) revert RecipientNotOwner();

        // ── 1. Pull USDC from the owner (who pre-approved this contract) ──────
        //      onlyFacilitator: the pool pays the CCIP fee, so an open bridge()
        //      would let anyone spam near-zero transfers and drain the pool. Only
        //      the Q402 relayer may trigger a pool-paid send.
        bool ok = USDC.transferFrom(owner, address(this), amount);
        if (!ok) revert TransferFailed();

        // ── 2. Build CCIP EVM2Any message ────────────────────────────────────
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({
            token:  address(USDC),
            amount: amount
        });

        address feeTokenAddr;
        if (feeToken == FEE_TOKEN_LINK) {
            feeTokenAddr = address(LINK);
        } else if (feeToken == FEE_TOKEN_NATIVE) {
            feeTokenAddr = address(0);
        } else {
            revert UnknownFeeToken();
        }

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver:     abi.encode(destReceiver),
            data:         "",                                  // empty — token-only transfer (Phase 1)
            tokenAmounts: tokenAmounts,
            extraArgs:    Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit:                 0,               // EOA receiver — no callback gas needed
                    allowOutOfOrderExecution: true             // unblock independent messages
                })
            ),
            feeToken:     feeTokenAddr
        });

        // ── 3. Quote + max-fee guard ─────────────────────────────────────────
        uint256 fee = ROUTER.getFee(destChainSelector, message);
        if (fee > maxFee) revert FeeExceedsMax();

        // ── 4. Pay fee from pool + send ──────────────────────────────────────
        if (feeToken == FEE_TOKEN_LINK) {
            if (LINK.balanceOf(address(this)) < fee) revert InsufficientLinkPool();
            messageId = ROUTER.ccipSend(destChainSelector, message);
        } else {
            if (address(this).balance < fee) revert InsufficientNativePool();
            messageId = ROUTER.ccipSend{value: fee}(destChainSelector, message);
        }

        emit BridgeInitiated(
            messageId,
            owner,
            destChainSelector,
            destReceiver,
            amount,
            feeToken,
            fee
        );
    }

    // ─── Pool management (facilitator-only) ───────────────────────────────────

    /// @notice Top up the LINK pool. Facilitator transfers LINK in.
    function topupLink(uint256 amount) external {
        bool ok = LINK.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit LinkPoolTopup(msg.sender, amount);
    }

    /// @notice Top up the native pool. Anyone can send (just hits receive()).
    receive() external payable {
        emit NativePoolTopup(msg.sender, msg.value);
    }

    /// @notice Facilitator withdraws LINK from the pool.
    function withdrawLink(uint256 amount, address to) external {
        if (msg.sender != FACILITATOR) revert OnlyFacilitator();
        bool ok = LINK.transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit PoolWithdraw(address(LINK), to, amount);
    }

    /// @notice Facilitator withdraws native from the pool.
    function withdrawNative(uint256 amount, address payable to) external {
        if (msg.sender != FACILITATOR) revert OnlyFacilitator();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PoolWithdraw(address(0), to, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    /// @notice Quote CCIP fee for a hypothetical bridge. View-only.
    function quoteFee(
        uint64  destChainSelector,
        uint256 amount,
        address destReceiver,
        uint8   feeToken
    ) external view returns (uint256 fee) {
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({
            token:  address(USDC),
            amount: amount
        });

        address feeTokenAddr;
        if (feeToken == FEE_TOKEN_LINK)        feeTokenAddr = address(LINK);
        else if (feeToken == FEE_TOKEN_NATIVE) feeTokenAddr = address(0);
        else                                    revert UnknownFeeToken();

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver:     abi.encode(destReceiver),
            data:         "",
            tokenAmounts: tokenAmounts,
            extraArgs:    Client._argsToBytes(Client.GenericExtraArgsV2({
                gasLimit:                 0,
                allowOutOfOrderExecution: true
            })),
            feeToken:     feeTokenAddr
        });

        fee = ROUTER.getFee(destChainSelector, message);
    }

    /// @notice Per-pool balance.
    function poolBalances() external view returns (uint256 linkBalance, uint256 nativeBalance) {
        linkBalance   = LINK.balanceOf(address(this));
        nativeBalance = address(this).balance;
    }
}
