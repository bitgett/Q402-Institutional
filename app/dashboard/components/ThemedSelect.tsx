"use client";

/**
 * ThemedSelect — drop-in replacement for `<select>` that keeps the dark
 * theme inside the dropdown panel. Native `<select>` on Windows
 * Chrome renders the option list with the OS picker (white background,
 * black text) regardless of CSS, which clashes badly with the Agent
 * Wallet modal palette.
 *
 * Behaviour parity with native:
 *   - keyboard: Esc closes, ArrowUp/Down navigates, Enter / Space picks
 *   - click outside closes
 *   - disabled options can be marked + skipped
 *   - works inside modals (no portal — uses absolute positioning under
 *     the trigger, so the parent z-index applies automatically)
 *
 * Intentionally NOT a full combobox / async / multi-select. This is the
 * minimum needed to render a chain or weekday picker without the OS
 * styling artifact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ThemedSelectOption<V extends string> {
  value: V;
  label: string;
  /** Smaller text shown right-aligned in the option row. */
  meta?: string;
  disabled?: boolean;
}

interface Props<V extends string> {
  value: V;
  onChange: (next: V) => void;
  options: ThemedSelectOption<V>[];
  disabled?: boolean;
  /** Inline-wide; matches the previous `<select>`'s w-full default. */
  className?: string;
  /** Optional aria-label for screen readers. */
  ariaLabel?: string;
}

export function ThemedSelect<V extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  ariaLabel,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState<number>(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => options.find((o) => o.value === value), [options, value]);

  /**
   * Open the panel + position the highlight on the current value so a
   * subsequent ArrowDown/Up walks from the right place. Driven by user
   * intent (click / keyboard), NOT a useEffect — React 19's
   * react-hooks/set-state-in-effect rule rejects setState inside an
   * effect when the trigger is itself reactive to props/state.
   */
  const openPanel = useCallback(() => {
    if (disabled) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlightIdx(idx >= 0 ? idx : 0);
    setOpen(true);
  }, [disabled, options, value]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Esc closes; Up/Down navigate; Enter/Space picks.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPanel();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => {
          // Walk forward, skipping disabled rows. Stop at the end.
          for (let j = i + 1; j < options.length; j++) {
            if (!options[j].disabled) return j;
          }
          return i;
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => {
          for (let j = i - 1; j >= 0; j--) {
            if (!options[j].disabled) return j;
          }
          return i;
        });
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const opt = options[highlightIdx];
        if (opt && !opt.disabled) {
          onChange(opt.value);
          setOpen(false);
        }
      }
    },
    [open, disabled, options, highlightIdx, onChange, openPanel],
  );

  return (
    <div
      ref={wrapRef}
      className={`relative ${className ?? "w-full"}`}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: "#0B1626",
          borderColor: open ? "rgba(74,222,128,0.40)" : "rgba(255,255,255,0.10)",
        }}
      >
        <span className="truncate text-left flex-1">
          {selected ? (
            <>
              {selected.label}
              {selected.meta && (
                <span className="text-white/40"> · {selected.meta}</span>
              )}
            </>
          ) : (
            <span className="text-white/40">Select…</span>
          )}
        </span>
        <span
          className="text-white/50 text-xs transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          aria-hidden
        >
          ▼
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-md border shadow-lg z-10"
          style={{
            background: "#0B1626",
            borderColor: "rgba(255,255,255,0.10)",
            boxShadow: "0 10px 30px -8px rgba(0,0,0,0.6)",
          }}
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value;
            const isHighlight = i === highlightIdx;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={opt.disabled}
                onMouseEnter={() => setHighlightIdx(i)}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: isHighlight && !opt.disabled
                    ? "rgba(74,222,128,0.10)"
                    : "transparent",
                  color: isSelected ? "#86efac" : "#E2E8F0",
                }}
              >
                <span className="truncate flex-1">{opt.label}</span>
                {opt.meta && (
                  <span className="text-[11px] text-white/40 shrink-0">{opt.meta}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
