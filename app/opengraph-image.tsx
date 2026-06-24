import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Node.js runtime — the edge bundle exceeded Vercel's 1 MB edge-function limit
// after the Next 16 / React 19 upgrade. OG image generation is not latency-sensitive.
export const runtime = "nodejs";
export const alt = "Q402 | Gasless payments on any EVM chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Poppins is the site's body + brand wordmark face (see app/layout.tsx). Satori
// cannot read the woff2 next/font cache, so the static TTFs are co-located under
// app/_fonts and read off disk. On the Node runtime the `new URL(..., import.meta.url)`
// + fetch pattern resolves to an unfetchable relative path, so we read the bytes
// directly; the route prerenders to a static PNG at build time. next.config's
// outputFileTracingIncludes ships the fonts in case the route is served dynamically.
export default async function Image() {
  const fontDir = join(process.cwd(), "app", "_fonts");
  const [extraBold, bold, light] = await Promise.all([
    readFile(join(fontDir, "Poppins-ExtraBold.ttf")),
    readFile(join(fontDir, "Poppins-Bold.ttf")),
    readFile(join(fontDir, "Poppins-Light.ttf")),
  ]);

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
          fontFamily: "Poppins",
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
        <div style={{ display: "flex", flexDirection: "column", fontSize: "78px", fontWeight: 800, color: "#ffffff", lineHeight: 1.05, letterSpacing: "-3px" }}>
          <span>Gasless payments</span>
          <span>on any EVM chain</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Poppins", data: extraBold, weight: 800, style: "normal" },
        { name: "Poppins", data: bold, weight: 700, style: "normal" },
        { name: "Poppins", data: light, weight: 300, style: "normal" },
      ],
    },
  );
}
