/**
 * /dashboard/v2 — legacy redirect.
 *
 * The v2 dashboard now renders at /dashboard itself (app/dashboard/page.tsx
 * mounts <DashboardV2/> inside the identity provider). This route is kept only
 * so the old /dashboard/v2 URL still resolves — it permanently forwards to
 * /dashboard, which carries the auth/identity state machine the v2 shell needs.
 */

import { redirect } from "next/navigation";

export default function DashboardV2Page() {
  redirect("/dashboard");
}
