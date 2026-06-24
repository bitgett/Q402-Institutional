/**
 * action-icons — stroke glyphs for the wallet action row (Send / Receive /
 * Batch / Withdraw). Same contract as v2/logos.tsx icons: 24-viewBox, round
 * caps, currentColor stroke, scaled by size. Bridge + Stake use brand images
 * (link.jpg, quack.svg) so they live inline at the call site, not here.
 */

interface P {
  size?: number;
  color?: string;
}

function svg(size: number, color: string | undefined, children: React.ReactNode) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? "currentColor"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** Send — diagonal arrow leaving up-right. */
export function SendGlyph({ size = 18, color }: P) {
  return svg(size, color, (
    <>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </>
  ));
}

/** Receive — arrow landing onto a baseline. */
export function ReceiveGlyph({ size = 18, color }: P) {
  return svg(size, color, (
    <>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ));
}

/** Batch — stacked rows fanning out to many. */
export function BatchGlyph({ size = 18, color }: P) {
  return svg(size, color, (
    <>
      <path d="M4 7h11" />
      <path d="M4 12h16" />
      <path d="M4 17h8" />
    </>
  ));
}

/** Withdraw — arrow lifting up off a baseline (sweep out). */
export function WithdrawGlyph({ size = 18, color }: P) {
  return svg(size, color, (
    <>
      <path d="M12 20V9" />
      <path d="M7 14l5-5 5 5" />
      <path d="M5 4h14" />
    </>
  ));
}
