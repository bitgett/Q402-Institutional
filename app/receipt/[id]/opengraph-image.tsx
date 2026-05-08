import { ImageResponse } from "next/og";
import { getReceipt, publicView } from "@/app/lib/receipt";

// Match the rest of the app: opengraph-image runs on Node so we can reuse
// the KV import. Also avoids the 1MB Edge bundle limit (same reasoning as
// app/opengraph-image.tsx).
export const runtime = "nodejs";

export const alt          = "Q402 Trust Receipt — verified settlement";
export const size         = { width: 1200, height: 630 };
export const contentType  = "image/png";

const CHAIN_LABELS: Record<string, string> = {
  bnb:       "BNB Chain",
  eth:       "Ethereum",
  avax:      "Avalanche",
  xlayer:    "X Layer",
  stable:    "Stable",
  mantle:    "Mantle",
  injective: "Injective EVM",
};

export default async function OgImage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const valid  = /^rct_[0-9a-f]{24}$/.test(id);
  const r      = valid ? await getReceipt(id) : null;
  const view   = r ? publicView(r) : null;

  if (!view) {
    return new ImageResponse(
      <div style={{ ...baseStyle, color: "#fff" }}>
        <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: -1 }}>
          Q402 · Receipt not found
        </div>
      </div>,
      size,
    );
  }

  const chainLabel = CHAIN_LABELS[view.chain] ?? view.chain;
  const issued = new Date(view.createdAt).toUTCString();

  return new ImageResponse(
    <div style={baseStyle}>
      {/* Header strip */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "44px 60px 0", color: "#F5C518",
        fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase",
      }}>
        <div>Q402 · Trust Receipt</div>
        <div style={{ color: "#7A8299", fontWeight: 500, letterSpacing: 2, fontSize: 16 }}>
          {view.receiptId}
        </div>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        justifyContent: "center", padding: "0 60px",
      }}>
        {/* Verified badge */}
        <div style={{
          display: "flex", alignItems: "center", gap: 18,
          color: view.sandbox ? "#FFB066" : "#4AE54A",
          fontSize: 28, fontWeight: 700, marginBottom: 22,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 22,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: view.sandbox ? "rgba(255,176,102,0.16)" : "rgba(74,229,74,0.16)",
            border: `2px solid ${view.sandbox ? "rgba(255,176,102,0.55)" : "rgba(74,229,74,0.55)"}`,
            fontSize: 26,
          }}>
            {view.sandbox ? "△" : "✓"}
          </div>
          <span>{view.sandbox ? "Sandbox — not a real settlement" : "Verified settlement"}</span>
        </div>

        {/* Big amount */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginBottom: 36 }}>
          <span style={{ color: "#fff", fontSize: 132, fontWeight: 800, letterSpacing: -4, lineHeight: 1 }}>
            {view.tokenAmount}
          </span>
          <span style={{ color: "#9AA3BD", fontSize: 44, fontWeight: 600 }}>
            {view.token}
          </span>
        </div>

        {/* Meta row */}
        <div style={{
          display: "flex", flexDirection: "column", gap: 14,
          color: "#B6BFD6", fontSize: 26,
        }}>
          <div style={{ display: "flex", gap: 28 }}>
            <span style={{ color: "#7A8299", width: 130 }}>Chain</span>
            <span style={{ color: "#fff", fontWeight: 600 }}>{chainLabel}</span>
          </div>
          <div style={{ display: "flex", gap: 28 }}>
            <span style={{ color: "#7A8299", width: 130 }}>Method</span>
            <span style={{ color: "#fff", fontFamily: "monospace" }}>{view.method}</span>
          </div>
          <div style={{ display: "flex", gap: 28 }}>
            <span style={{ color: "#7A8299", width: 130 }}>Tx</span>
            <span style={{ color: "#fff", fontFamily: "monospace" }}>
              {view.txHash.slice(0, 14)}…{view.txHash.slice(-8)}
            </span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: "24px 60px 36px", color: "#5A627A", fontSize: 18,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span>Issued {issued}</span>
        <span style={{ color: "#7A8299" }}>q402.quackai.ai</span>
      </div>
    </div>,
    size,
  );
}

const baseStyle: React.CSSProperties = {
  width: "100%", height: "100%",
  display: "flex", flexDirection: "column",
  background: "linear-gradient(135deg, #0B0F1A 0%, #131A2B 60%, #0F1424 100%)",
  fontFamily: "Inter, system-ui, sans-serif",
};
