import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getReceipt, publicView, type Receipt } from "@/app/lib/receipt";
import ReceiptCard from "./ReceiptCard";

// Receipt pages are dynamic — they read KV per request and the webhook
// delivery state can change between renders.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const receipt = /^rct_[0-9a-f]{24}$/.test(id) ? await getReceipt(id) : null;
  if (!receipt) return { title: "Receipt not found · Q402" };

  const view = publicView(receipt);
  const title = `${view.tokenAmount} ${view.token} · Q402 Receipt`;
  const desc  = `Verified Q402 settlement on ${chainLabel(view.chain)}. Tx ${view.txHash.slice(0, 10)}…`;

  return {
    title,
    description: desc,
    // Receipt URLs are unguessable but, once shared in messengers / X /
    // GitHub issues, search engine crawlers can pick them up. The whole
    // model is "shareable to a specific audience, not indexed publicly" —
    // ask robots to skip both the page and the OG image. Belt-and-suspenders
    // with the X-Robots-Tag header on /api/receipt/[id].
    robots: { index: false, follow: false, nocache: true },
    openGraph: {
      title,
      description: desc,
      type: "website",
      // opengraph-image.tsx in this directory provides the auto-generated
      // 1200x630 card; Next.js wires it up automatically.
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: desc,
    },
  };
}

export default async function ReceiptPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^rct_[0-9a-f]{24}$/.test(id)) notFound();

  const receipt = await getReceipt(id);
  if (!receipt) notFound();

  return <ReceiptCard initialReceipt={publicView(receipt) as Receipt} />;
}

// Lightweight chain labels mirrored from wallet.ts so this page can render
// without pulling the full client-only WALLET_CHAINS module.
function chainLabel(chain: string): string {
  switch (chain) {
    case "bnb":       return "BNB Chain";
    case "eth":       return "Ethereum";
    case "avax":      return "Avalanche";
    case "xlayer":    return "X Layer";
    case "stable":    return "Stable";
    case "mantle":    return "Mantle";
    case "injective": return "Injective EVM";
    default:          return chain;
  }
}
