import type { Metadata } from "next";

/**
 * /visualization — fullscreen embed of the live Q402 settlement scene.
 *
 * Iframe target is configured via NEXT_PUBLIC_Q402_VIZ_URL so the
 * upstream deploy can swap without a code change. Falls back to a
 * default backend slug when the env is unset.
 */
export const metadata: Metadata = {
  title: "Q402 — Autonomous Agent Settlement Network",
  description:
    "Live 3D visualization of the Q402 relayer settling gasless USDT + USDC payments on BNB Chain across a pool of autonomous wallet agents.",
};

const VIZ_URL =
  process.env["NEXT_PUBLIC_Q402_VIZ_URL"] ??
  "https://q402-viz-backend.onrender.com";

export default function VisualizationPage() {
  return (
    <div className="fixed inset-0 h-screen w-screen bg-black">
      <iframe
        src={VIZ_URL}
        title="Q402 Autonomous Agent Settlement Network"
        className="h-full w-full border-0"
        allow="fullscreen"
        // The viz fetches Q402 stats from q402.quackai.ai itself, so
        // same-origin allowances aren't an issue; the iframe just
        // renders the Three.js scene served by the upstream backend.
      />
    </div>
  );
}
