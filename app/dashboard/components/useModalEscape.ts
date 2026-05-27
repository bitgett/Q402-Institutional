"use client";

/**
 * useModalEscape — common Escape-to-close hook for the Agent Wallet
 * modals so behaviour matches across the whole surface.
 *
 * Pass:
 *   - `onClose`: the close handler the modal already exposes
 *   - `disabled`: boolean — true while an in-flight request is pending
 *                 (signing, POSTing, …). When disabled the Escape key
 *                 is ignored so the user can't bail mid-request and
 *                 strand the modal trying to setState on an unmounted
 *                 tree.
 *
 * The handler reads `disabled` and `onClose` through a ref so callers
 * don't need to memoise — every render's latest values are used
 * without re-binding the keydown listener.
 */

import { useEffect, useRef } from "react";

export function useModalEscape(onClose: () => void, disabled = false): void {
  const ref = useRef({ onClose, disabled });
  // React 19's react-hooks/refs rule forbids updating refs during
  // render — do it from an effect instead. The two-effect split is
  // intentional: the latch effect runs on every render so the
  // keydown effect can read the freshest values without re-binding
  // the global listener.
  useEffect(() => {
    ref.current = { onClose, disabled };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (ref.current.disabled) return;
      ref.current.onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
