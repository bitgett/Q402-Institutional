/**
 * Small, shared env/mode badge (Sandbox / Live) used across landing, dashboard,
 * and docs to give a consistent visual signal of which environment a surface
 * operates in. Intentionally flat and muted — this is a status marker, not a
 * marketing element.
 */

type Variant = "live" | "sandbox" | "neutral";

const STYLES: Record<Variant, { dot: string; text: string; bg: string; border: string }> = {
  live: {
    dot:    "#F5C518",
    text:   "#F5C518",
    bg:     "rgba(245,197,24,0.10)",
    border: "rgba(245,197,24,0.32)",
  },
  sandbox: {
    dot:    "#4ade80",
    text:   "#4ade80",
    bg:     "rgba(74,222,128,0.08)",
    border: "rgba(74,222,128,0.28)",
  },
  neutral: {
    dot:    "#94a3b8",
    text:   "rgba(255,255,255,0.55)",
    bg:     "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.12)",
  },
};

export function EnvBadge({
  variant,
  label,
  className = "",
}: {
  variant: Variant;
  label?: string;
  className?: string;
}) {
  const s = STYLES[variant];
  const text = label ?? (variant === "live" ? "Live" : variant === "sandbox" ? "Sandbox" : "—");
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${className}`}
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: s.dot, boxShadow: `0 0 5px ${s.dot}` }}
      />
      {text}
    </span>
  );
}

/**
 * Horizontal strip of capability/trust markers used under the landing hero
 * and anywhere else the product wants to surface what it actually ships with.
 * Items are derived from real features in the codebase — not aspirational.
 */
export function TrustStrip({ className = "" }: { className?: string }) {
  const items = [
    "EIP-7702 Type-4",
    "5 EVM Chains",
    "Sandbox / Live Keys",
    "Webhook · HMAC-signed",
    "Per-key daily caps",
    "Audit-ready delivery log",
  ];
  return (
    <div
      className={`flex flex-wrap gap-2 ${className}`}
      aria-label="Q402 capabilities"
    >
      {items.map(item => (
        <span
          key={item}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-mono text-white/55"
        >
          <span
            className="w-1 h-1 rounded-full bg-white/40"
            aria-hidden
          />
          {item}
        </span>
      ))}
    </div>
  );
}
