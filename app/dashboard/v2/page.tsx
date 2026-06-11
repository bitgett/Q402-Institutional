/**
 * /dashboard/v2 — V2 dashboard route.
 *
 * Standalone route so the V2 dashboard ships behind a distinct URL without
 * touching the existing /dashboard (app/dashboard/page.tsx). DashboardV2 is
 * a client component; this server entry just mounts it.
 */

import DashboardV2 from "./DashboardV2";

export default function DashboardV2Page() {
  return <DashboardV2 />;
}
