import type { ReactNode } from "react";
import { DM_Sans, Space_Grotesk } from "next/font/google";

/**
 * v2 dashboard layout — scopes the DM Sans (body) + Space Grotesk (display/
 * numbers) fonts to the /dashboard/v2 subtree only, so the global app fonts
 * (Poppins / Bricolage in app/layout.tsx) stay untouched.
 *
 * The font CSS variables are consumed by the v2 primitives through
 * `var(--font-dm-sans)` / `var(--font-space-grotesk)`.
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

export default function DashboardV2Layout({ children }: { children: ReactNode }) {
  return (
    <div className={`${dmSans.variable} ${spaceGrotesk.variable}`}>
      {children}
    </div>
  );
}
