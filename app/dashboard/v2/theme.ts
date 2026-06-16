/**
 * Q402 Dashboard V2 — design tokens.
 *
 * Mirrors the `:root` CSS variables from the reference prototype
 * (`q402-agentic-wallet-concept/dashboard-v2.html`). The whole v2 surface
 * (primitives + views + the re-skinned agentic modals) reads from here so
 * the palette has a single source of truth and a future re-theme is a
 * one-file change.
 *
 * IMPORTANT — accent re-skin contract:
 *   The reused agentic-wallet modals (app/dashboard/components/Agentic*.tsx)
 *   hard-code an EMERALD accent (rgba(74,222,128,…) / #86efac / #4ade80).
 *   v2 is YELLOW-branded. Rather than rewrite 12 modals in this foundation
 *   pass, we expose `V2_ACCENT` (+ the rgba/soft variants) here and a
 *   <V2AccentScope> CSS-variable wrapper in primitives.tsx. The next phase
 *   either (a) wraps each modal mount in <V2AccentScope> and swaps the
 *   modal's literals to `var(--v2-accent*)`, or (b) passes an `accent`
 *   prop through. Either way the EMERALD literals stay the default when a
 *   modal renders OUTSIDE a v2 scope, so the existing /dashboard is
 *   untouched. Do NOT edit the shared modals' emerald defaults globally.
 */

export const v2 = {
  // Core surfaces / text (verbatim from the prototype :root block).
  bg: "#07101f",
  panel: "#0b1729",
  panel2: "#101e32",
  line: "rgba(255,255,255,.085)",
  text: "#f2f0e8",
  muted: "#9BA8BD", // lightened from #8993a6 for WCAG AA on glass surfaces
  muted2: "#616d81", // low-contrast — ONLY use at >=16px (fails AA below that)
  yellow: "#F5C518", // canonical Q402 brand gold (matches Q402-logo.svg + landing nav)
  mint: "#55e6a5",
  cyan: "#58c7f4",
  red: "#ff7777",

  // One-off literals the prototype uses inline — surfaced so views don't
  // re-discover them.
  surfaceFill: "rgba(9,20,36,.78)", // .surface background
  topbarFill: "#07101f", // sticky topbar — opaque AND exactly the page bg (v2.bg) so the bar has zero colour difference vs the background and the top-right teal glow can't tint one end; the 1px bottom border is the only delineation
  modalFill: "#0c1829", // .modal background
  inputFill: "#07111f", // .field input / .keybox / .code background
  ringTrack: "#19273b",
  ringInner: "#0c1829",
  coinUsdt: "#1f2b40", // stablecoin coin chip — neutral glass navy (the USDT logo already carries Tether green; chip is just the backing circle)
  chartViolet: "#747fff", // chainbar 3rd segment
  toggleOff: "#1a293c",
  toggleKnob: "#748096",
  toastBg: "#edf1f5",
  toastText: "#0b1422",
  markInner: "#0B1220", // logo inner square
  actionText: "#101722", // primary action / scope-active text
  yieldBtnText: "#06150f",
} as const;

/**
 * Readable type scale. The reference prototype set everything at 8–11px,
 * which is unreadable in a real product. These are the FLOORS the v2 surface
 * uses — nothing meaningful should render below `fs.micro`.
 */
export const fs = {
  micro: 11, // badges / fine print (prototype 8–9)
  label: 12, // eyebrows, field labels, meta (prototype 9–10)
  body: 13, // secondary body text (prototype 10–11)
  base: 14, // primary body, row/table text (prototype 11–12)
  cardTitle: 15, // card / row titles (prototype 12–13)
  title: 17, // section titles (prototype 13–14)
  h2: 22, // view titles (prototype 21)
  hero: 34, // hero balance / big numbers
} as const;

/**
 * V2 brand accent (replaces the emerald used by the off-branch agentic UI).
 * `soft` / `line` / `fill` mirror the alpha tiers the modals reach for.
 */
export const V2_ACCENT = v2.yellow; // #f7ca16
export const V2_ACCENT_SOFT = "rgba(247,202,22,.10)"; // highlight / hover bg
export const V2_ACCENT_LINE = "rgba(247,202,22,.30)"; // active border
export const V2_ACCENT_FILL = "rgba(247,202,22,.06)"; // tinted surface fill
export const V2_ACCENT_TEXT = "#f9d64a"; // selected-row text (lighter than base yellow)

/** Brand-yellow defaults the shared modals fall back to outside a v2 scope
 *  (kept yellow so no green leaks even on the off-branch path). */
export const OFFBRANCH_ACCENT = "#F5C518";
export const OFFBRANCH_ACCENT_TEXT = "#f9d64a";

/**
 * Geometry tokens — corner radii, card insets (padding), and rail/column
 * widths the v2 surface reuses. Centralized so spacing stays consistent and a
 * future density change is a one-file edit. All values in px.
 */
export const v2Radius = {
  surface: 19, // outer frosted .surface panels (matches glass() default)
  card: 15, // primary content cards
  subCard: 13, // inner sub-cards (matches subCard() default)
  tight: 11, // compact cells / inline cards
  chip: 8, // pills / chips / small badges
} as const;

export const v2Insets = {
  primaryCard: 16, // padding inside primary content cards
  assetCard: 14, // padding inside asset / token rows
  miniCard: 12, // padding inside compact mini-cards
  modal: 20, // padding inside modal bodies
  heroV: 24, // vertical padding of the hero balance block
  heroH: 25, // horizontal padding of the hero balance block
} as const;

export const v2Columns = {
  railLeft: 230, // left nav rail width
  railRight: 300, // right context rail width
  consoleMin: 560, // min width of the center console column
  gridGap: 18, // gap between rail/console columns
} as const;

/**
 * Gas-tank coin chip gradient — the literal the WalletsView gas chip uses
 * today (deep navy slate). Surfaced so the value lives in one place.
 */
export const gasTankCoinGradient = "linear-gradient(135deg,#2c3c57,#172234)";

/**
 * glass(radius) — the canonical .surface treatment as inline-style props.
 * Use for any card that should read as a frosted panel.
 */
export function glass(radius = 19): React.CSSProperties {
  return {
    border: `1px solid ${v2.line}`,
    background: v2.surfaceFill,
    borderRadius: radius,
    boxShadow: "0 24px 80px rgba(0,0,0,.23)",
    backdropFilter: "blur(17px)",
    WebkitBackdropFilter: "blur(17px)",
  };
}

/** Lighter inner sub-card fill (asset/yield/commit/limit cards). */
export function subCard(radius = 13, fillAlpha = 0.017): React.CSSProperties {
  return {
    border: `1px solid ${v2.line}`,
    background: `rgba(255,255,255,${fillAlpha})`,
    borderRadius: radius,
  };
}

/**
 * CSS custom-property bag — spread onto a wrapper's `style` so descendant
 * elements (incl. the reused modals once migrated) can read tokens as
 * `var(--v2-yellow)` etc. The accent vars deliberately point at YELLOW so a
 * subtree wrapped in this scope re-skins the emerald literals.
 */
export const v2CssVars: React.CSSProperties = {
  ["--v2-bg" as string]: v2.bg,
  ["--v2-panel" as string]: v2.panel,
  ["--v2-line" as string]: v2.line,
  ["--v2-text" as string]: v2.text,
  ["--v2-muted" as string]: v2.muted,
  ["--v2-muted2" as string]: v2.muted2,
  ["--v2-yellow" as string]: v2.yellow,
  ["--v2-mint" as string]: v2.mint,
  ["--v2-cyan" as string]: v2.cyan,
  ["--v2-red" as string]: v2.red,
  // Accent aliases consumed by re-skinned modals:
  ["--v2-accent" as string]: V2_ACCENT,
  ["--v2-accent-soft" as string]: V2_ACCENT_SOFT,
  ["--v2-accent-line" as string]: V2_ACCENT_LINE,
  ["--v2-accent-fill" as string]: V2_ACCENT_FILL,
  ["--v2-accent-text" as string]: V2_ACCENT_TEXT,
};

/** Scope value threaded from the topbar ScopeChip through the views. */
export type Scope = "trial" | "multichain";

/** Task views in the v2 top nav. */
export type V2ViewId = "wallets" | "activity" | "treasury" | "developer";
