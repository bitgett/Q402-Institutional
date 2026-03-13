import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Q402 | Gasless Payments on EVM";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#0a0e1a",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "80px",
          position: "relative",
        }}
      >
        {/* Background glow */}
        <div
          style={{
            position: "absolute",
            top: "-100px",
            right: "-100px",
            width: "600px",
            height: "600px",
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,200,0,0.12) 0%, transparent 70%)",
            display: "flex",
          }}
        />

        {/* Badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: "rgba(255,200,0,0.1)",
            border: "1px solid rgba(255,200,0,0.4)",
            borderRadius: "999px",
            padding: "6px 18px",
            marginBottom: "32px",
          }}
        >
          <span style={{ color: "#ffc800", fontSize: "15px", fontWeight: 700, letterSpacing: "2px" }}>
            QUACK AI · Q402
          </span>
        </div>

        {/* Title line 1 */}
        <div
          style={{
            display: "flex",
            fontSize: "72px",
            fontWeight: 800,
            color: "#ffffff",
            lineHeight: 1.1,
          }}
        >
          Gasless Payments on EVM.
        </div>

        {/* Title line 2 - colored */}
        <div
          style={{
            display: "flex",
            fontSize: "72px",
            fontWeight: 800,
            color: "#ffc800",
            lineHeight: 1.1,
            marginBottom: "24px",
          }}
        >
          Powered by Q402.
        </div>

        {/* Subtitle */}
        <div
          style={{
            display: "flex",
            fontSize: "26px",
            color: "rgba(255,255,255,0.5)",
            marginBottom: "56px",
            maxWidth: "680px",
          }}
        >
          Your users pay zero gas. You sponsor it — invisibly and instantly.
        </div>

        {/* Chain pills */}
        <div style={{ display: "flex", gap: "12px" }}>
          {["BNB Chain", "Ethereum", "Avalanche", "X Layer"].map((chain) => (
            <div
              key={chain}
              style={{
                display: "flex",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "999px",
                padding: "8px 20px",
                color: "rgba(255,255,255,0.7)",
                fontSize: "16px",
                fontWeight: 500,
              }}
            >
              {chain}
            </div>
          ))}
        </div>

        {/* Bottom URL */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            bottom: "48px",
            right: "80px",
            color: "rgba(255,255,255,0.25)",
            fontSize: "18px",
          }}
        >
          q402-institutional.vercel.app
        </div>
      </div>
    ),
    { ...size }
  );
}
