"use client";

/**
 * AgenticWalletStakeModal — thin modal shell around AgenticWalletStakeSection,
 * so Q staking opens from the wallet action row like Send / Receive / Batch.
 * The section carries its own header (Q logo + "Q Staking" + chain), so the
 * shell only adds the backdrop, panel, and a close affordance.
 */

import { createPortal } from "react-dom";
import { AgenticWalletStakeSection } from "./AgenticWalletStakeSection";
import { useModalEscape } from "./useModalEscape";

interface Props {
  ownerAddress: string;
  walletId: string;
  signMessage: (message: string) => Promise<string | null>;
  onClose: () => void;
}

export function AgenticWalletStakeModal({ ownerAddress, walletId, signMessage, onClose }: Props) {
  // Escape always closes — the only unsaved state is an unsubmitted amount.
  useModalEscape(onClose, false);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(2,6,15,0.72)" }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border p-6"
        style={{ background: "#0F1929", borderColor: "rgba(247,202,22,0.20)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-white/40 hover:text-white text-lg leading-none"
        >
          ×
        </button>
        <AgenticWalletStakeSection ownerAddress={ownerAddress} walletId={walletId} signMessage={signMessage} />
      </div>
    </div>,
    document.body,
  );
}
