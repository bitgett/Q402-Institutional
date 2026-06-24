import { ImageResponse } from "next/og";

// Node.js runtime — the edge bundle exceeded Vercel's 1 MB edge-function limit
// after the Next 16 / React 19 upgrade. OG image generation is not latency-sensitive.
export const runtime = "nodejs";
export const alt = "Q402 | Gasless payments for the agentic web";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "76px 80px",
          background: "linear-gradient(140deg, #16345c 0%, #0b1729 50%, #060c17 100%)",
          position: "relative",
        }}
      >
        {/* Soft gold glow — brand accent, top-right */}
        <div
          style={{
            position: "absolute",
            top: "-180px",
            right: "-140px",
            width: "620px",
            height: "620px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(247,202,22,0.18) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* Top-left: logo + wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <svg width="58" height="58" viewBox="0 0 390.12 383.13">
            <path
              fill="#FFDA00"
              d="M327.66,367.55H62.91c-23.88,0-43.24-19.36-43.24-43.24V59.55c0-23.88,19.36-43.24,43.24-43.24h264.76c23.88,0,43.24,19.36,43.24,43.24v264.76C370.9,348.19,351.55,367.55,327.66,367.55z"
            />
            <polygon fill="#0b1729" points="227.9,120.01 227.9,76.52 184.42,76.52 140.93,76.52 140.93,120.01 184.42,120.01" />
            <polygon fill="#0b1729" points="140.93,250.47 140.93,293.95 184.42,293.95 227.9,293.95 227.9,250.47 184.42,250.47" />
            <polygon fill="#0b1729" points="271.39,163.49 271.39,120.01 227.9,120.01 227.9,163.49 227.9,206.98 227.9,250.47 271.39,250.47 271.39,206.98" />
            <rect fill="#0b1729" x="271.39" y="250.47" width="43.49" height="43.49" />
            <polygon fill="#0b1729" points="140.93,163.49 140.93,120.01 97.44,120.01 97.44,163.49 97.44,206.98 97.44,250.47 140.93,250.47 140.93,206.98" />
          </svg>
          <span style={{ color: "#ffffff", fontSize: "42px", fontWeight: 800, letterSpacing: "-1px" }}>Q402</span>
        </div>

        {/* Bottom-left: headline + one-line subtitle */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: "72px", fontWeight: 800, color: "#ffffff", lineHeight: 1.06, letterSpacing: "-2.5px" }}>
            <span>Gasless payments for</span>
            <span>the agentic web</span>
          </div>
          <div style={{ display: "flex", marginTop: "28px", fontSize: "27px", color: "rgba(255,255,255,0.55)", fontWeight: 500 }}>
            Zero gas for your users · 11 EVM chains · MCP-native
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
