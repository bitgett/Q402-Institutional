// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Q402OftSender
 * @notice Cross-chain USDT (USDT0) bridge via LayerZero OFT — source-side entrypoint.
 * @dev Companion to Q402CCIPSender (USDC / Chainlink CCIP). Same pooled-fee model:
 *      this contract owns a NATIVE pool (topped up by the Q402 facilitator, refilled
 *      from the same Gas Tank machinery) and pays the LayerZero messaging fee from it.
 *      Per-user accounting lives in Q402 KV under `gastank:{address}:{chain}`.
 *
 *  Two differences from the CCIP sender, both deliberate:
 *
 *  1. FACILITATOR-GATED bridge (drain-proof).
 *     Q402CCIPSender.bridge() is permissionless and pays the CCIP fee from its pool,
 *     so anyone can spam near-zero bridges and drain the pool (the fee dwarfs the
 *     token moved). Here `bridgeFor` is `onlyFacilitator`: only the Q402 relayer may
 *     trigger a pool-paid send. The owner pre-approves this contract for USDT0/USDT;
 *     the facilitator moves ONLY that owner's approved balance, and the destination
 *     recipient is force-bound to the owner's own address (bytes32(owner)) — so even a
 *     compromised facilitator can only move a user's funds to the user's own address
 *     on another chain, never to a third party. The "then pay Alice" step is a
 *     separate Q402 payment on the destination chain, never a bridge recipient.
 *
 *  2. Native fee only. LayerZero fees are paid in the native gas token (no LINK path).
 *
 *  No owner, no proxy, no upgradeability, no admin key beyond the immutable
 *  FACILITATOR (which can only withdraw the pool and trigger owner-bound sends).
 *
 *  OFT vs Adapter: on chains where USDT0 is a native OFT, OFT == the token and
 *  send() burns from this contract's balance. On Ethereum USDT0 is an OFT *adapter*
 *  wrapping native USDT, so OFT != token and send() pulls via transferFrom; the
 *  constructor pre-approves the adapter for the token in that case.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

// ─── Minimal LayerZero OFT interface (field order matches @layerzerolabs/oft-evm) ──

struct SendParam {
    uint32  dstEid;        // destination LayerZero endpoint id
    bytes32 to;            // recipient on the destination chain (left-padded address)
    uint256 amountLD;      // amount in local decimals
    uint256 minAmountLD;   // slippage floor; OFT reverts if received < this
    bytes   extraOptions;  // executor/lzReceive options (empty if enforcedOptions set)
    bytes   composeMsg;    // unused (no compose in v1)
    bytes   oftCmd;        // unused
}

struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

struct MessagingReceipt {
    bytes32 guid;
    uint64  nonce;
    MessagingFee fee;
}

struct OFTReceipt {
    uint256 amountSentLD;
    uint256 amountReceivedLD;
}

interface IOFT {
    function token() external view returns (address);
    function quoteSend(SendParam calldata sendParam, bool payInLzToken)
        external view returns (MessagingFee memory);
    function send(SendParam calldata sendParam, MessagingFee calldata fee, address refundAddress)
        external payable returns (MessagingReceipt memory, OFTReceipt memory);
}

contract Q402OftSender {

    // ─── Immutables (per-chain, hardwired at deploy) ─────────────────────────

    IOFT    public immutable OFT;          // USDT0 OFT (native OFT) or adapter (Ethereum)
    IERC20  public immutable TOKEN;        // token the owner holds/approves (USDT0, or USDT on Ethereum)
    address public immutable FACILITATOR;  // the only address allowed to trigger a send
    bool    public immutable IS_ADAPTER;   // true when OFT != TOKEN (adapter locks via transferFrom)

    // ─── Events ──────────────────────────────────────────────────────────────

    event OftBridgeInitiated(
        bytes32 indexed guid,
        address indexed owner,
        uint32  indexed dstEid,
        uint256         amountLD,
        uint256         amountReceivedLD,
        uint256         nativeFeePaid
    );
    event NativePoolTopup(address indexed from, uint256 amount);
    event PoolWithdraw(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error OnlyFacilitator();
    error FeeExceedsMax();
    error InsufficientNativePool();
    error TransferFailed();
    error ZeroOwner();

    modifier onlyFacilitator() {
        if (msg.sender != FACILITATOR) revert OnlyFacilitator();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address oft, address facilitator) {
        OFT         = IOFT(oft);
        FACILITATOR = facilitator;
        address underlying = IOFT(oft).token();
        TOKEN       = IERC20(underlying);
        IS_ADAPTER  = underlying != oft;
        // Adapter locks the underlying via transferFrom(this, ...), so pre-approve it
        // once. A native OFT burns from this contract's own balance and needs no
        // allowance, so we skip the approval there.
        if (IS_ADAPTER) {
            IERC20(underlying).approve(oft, type(uint256).max);
        }
    }

    // ─── Core: bridge (facilitator-gated) ────────────────────────────────────

    /**
     * @notice Bridge `amountLD` of the owner's USDT0/USDT to `dstEid`, delivered to
     *         the owner's own address on the destination chain.
     * @dev onlyFacilitator. The owner must have approved this contract for `amountLD`.
     *      The LayerZero native fee is paid from this contract's pool. Off-chain Gas
     *      Tank accounting (debit the owner's KV balance by the fee) is the Q402
     *      server's responsibility, exactly as with the CCIP sender.
     * @param owner        the account whose USDT0/USDT moves (recipient is forced to it)
     * @param dstEid       destination LayerZero endpoint id
     * @param amountLD     amount in local decimals
     * @param minAmountLD  slippage floor; the OFT reverts if the received amount is lower
     * @param maxNativeFee caller's max acceptable native fee; reverts on a higher quote
     * @param extraOptions executor options (empty when the OFT has enforcedOptions set)
     * @return guid        LayerZero message guid, traceable on layerzeroscan
     */
    function bridgeFor(
        address owner,
        uint32  dstEid,
        uint256 amountLD,
        uint256 minAmountLD,
        uint256 maxNativeFee,
        bytes calldata extraOptions
    ) external onlyFacilitator returns (bytes32 guid) {
        if (owner == address(0)) revert ZeroOwner();

        // 1. Pull the owner's token into this contract (owner pre-approved us).
        if (!TOKEN.transferFrom(owner, address(this), amountLD)) revert TransferFailed();

        // 2. Build the OFT send: recipient is HARD-BOUND to the owner on the dest chain.
        SendParam memory sp = SendParam({
            dstEid:       dstEid,
            to:           bytes32(uint256(uint160(owner))),
            amountLD:     amountLD,
            minAmountLD:  minAmountLD,
            extraOptions: extraOptions,
            composeMsg:   "",
            oftCmd:       ""
        });

        // 3. Quote + max-fee guard.
        MessagingFee memory fee = OFT.quoteSend(sp, false);
        if (fee.nativeFee > maxNativeFee)          revert FeeExceedsMax();
        if (address(this).balance < fee.nativeFee) revert InsufficientNativePool();

        // 4. Send. Fee from the pool; excess refunds back to the pool. The OFT
        //    enforces minAmountLD internally and reverts on a shortfall.
        (MessagingReceipt memory mr, OFTReceipt memory or_) =
            OFT.send{value: fee.nativeFee}(sp, fee, address(this));
        guid = mr.guid;

        emit OftBridgeInitiated(guid, owner, dstEid, amountLD, or_.amountReceivedLD, fee.nativeFee);
    }

    // ─── Pool management ──────────────────────────────────────────────────────

    /// @notice Top up the native fee pool. Anyone can send (hits receive()).
    receive() external payable {
        emit NativePoolTopup(msg.sender, msg.value);
    }

    /// @notice Facilitator withdraws native from the pool.
    function withdrawNative(uint256 amount, address payable to) external onlyFacilitator {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PoolWithdraw(address(0), to, amount);
    }

    /// @notice Facilitator rescues any ERC-20 stranded on this contract (e.g. a failed
    ///         send that already pulled the token). Not part of the normal flow.
    function withdrawToken(address token, uint256 amount, address to) external onlyFacilitator {
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        emit PoolWithdraw(token, to, amount);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    /// @notice Quote the native LayerZero fee for a hypothetical bridge. View-only.
    function quoteNativeFee(
        address owner,
        uint32  dstEid,
        uint256 amountLD,
        uint256 minAmountLD,
        bytes calldata extraOptions
    ) external view returns (uint256 nativeFee) {
        SendParam memory sp = SendParam({
            dstEid:       dstEid,
            to:           bytes32(uint256(uint160(owner))),
            amountLD:     amountLD,
            minAmountLD:  minAmountLD,
            extraOptions: extraOptions,
            composeMsg:   "",
            oftCmd:       ""
        });
        nativeFee = OFT.quoteSend(sp, false).nativeFee;
    }

    /// @notice Native pool balance.
    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
