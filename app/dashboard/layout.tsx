import type { ReactNode } from "react";
import { DM_Sans, Space_Grotesk } from "next/font/google";

/**
 * /dashboard layout — scopes the DM Sans (body) + Space Grotesk (display /
 * numbers) fonts to the whole /dashboard subtree (incl. /dashboard/v2), so
 * the v2 dashboard chrome rendered at /dashboard picks up its typography.
 *
 * Moved here from app/dashboard/v2/layout.tsx: now that DashboardV2 renders
 * at /dashboard (not just /dashboard/v2), the font CSS variables must be in
 * scope at the parent route. The v2 primitives consume them via
 * `var(--font-dm-sans)` / `var(--font-space-grotesk)`.
 *
 * The global app fonts (Poppins / Bricolage in app/layout.tsx) stay
 * untouched — this only ADDS the two CSS variables on the dashboard subtree.
 *
 * NOTE: WalletProvider is already global (app/layout.tsx → Providers). Do NOT
 * re-add it here.
 */

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${dmSans.variable} ${spaceGrotesk.variable}`}>
      {children}
    </div>
  );
}
