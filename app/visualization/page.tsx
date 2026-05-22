import type { Metadata } from "next";

/**
 * /visualization — public dashboard surfacing live Q402 settlement
 * activity on BNB Chain. Anyone running Q402 transactions appears as a
 * particle trail in real time.
 *
 * The page itself is a thin shell — the live scene is served by the
 * Q402 visualization backend, which polls public Q402 endpoints for
 * settlement data. The target URL is configurable via
 * NEXT_PUBLIC_Q402_VIZ_URL so the upstream deploy can swap without a
 * code change.
 */
export const metadata: Metadata = {
  title: "Q402 — Settlement Activity",
  description:
    "Live 3D dashboard of Q402 gasless USDT + USDC settlements on BNB Chain.",
};

const VIZ_URL =
  process.env["NEXT_PUBLIC_Q402_VIZ_URL"] ??
  "https://q402-viz-backend.onrender.com";

export default function VisualizationPage() {
  return (
    <div className="fixed inset-0 h-screen w-screen bg-black">
      <iframe
        src={VIZ_URL}
        title="Q402 Settlement Activity"
        className="h-full w-full border-0"
        allow="fullscreen"
      />
    </div>
  );
}
