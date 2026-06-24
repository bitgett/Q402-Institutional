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
          padding: "80px",
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

        {/* Top-left: the Navbar logo — yellow mark + Q402 wordmark + by Quack AI */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              display: "flex",
              width: "56px",
              height: "56px",
              borderRadius: "13px",
              background: "#F5C518",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 24px rgba(245,197,24,0.45)",
            }}
          >
            <div style={{ display: "flex", width: "24px", height: "24px", borderRadius: "5px", background: "rgba(7,16,31,0.9)" }} />
          </div>
          <span style={{ color: "#F5C518", fontSize: "44px", fontWeight: 700, letterSpacing: "-1.5px" }}>Q402</span>
          <span style={{ color: "rgba(255,255,255,0.32)", fontSize: "24px", fontWeight: 300, marginLeft: "4px", marginTop: "8px" }}>by Quack AI</span>
        </div>

        {/* Bottom-left: two-line headline, nothing else */}
        <div style={{ display: "flex", flexDirection: "column", fontSize: "76px", fontWeight: 800, color: "#ffffff", lineHeight: 1.05, letterSpacing: "-2.5px" }}>
          <span>Gasless payments for</span>
          <span>the agentic web</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
