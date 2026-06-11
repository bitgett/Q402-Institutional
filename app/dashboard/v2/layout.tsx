import type { ReactNode } from "react";

/**
 * /dashboard/v2 layout — pass-through.
 *
 * The DM Sans + Space Grotesk font loaders that used to live here moved UP to
 * app/dashboard/layout.tsx, so they apply across the whole /dashboard subtree
 * now that DashboardV2 renders at /dashboard. This route's page just
 * redirect()s to /dashboard, so this layout is effectively inert — kept as a
 * trivial wrapper so the v2 segment stays a valid route.
 */

export default function DashboardV2Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
