import type { Metadata, Viewport } from "next";
import { Poppins, JetBrains_Mono, Bricolage_Grotesque, Space_Grotesk } from "next/font/google";
import "./globals.css";
import Providers from "./components/Providers";
import { ReferralCapture } from "./components/ReferralCapture";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-poppins",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

// Display font for hero headlines + section headers. Bricolage Grotesque is a
// modern industrial-grotesque with strong contrast at large sizes — pairs well
// with Poppins body text without overlap. Loaded on every page via the html
// className but only opt-in via `font-display` / inline var(--font-display).
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

// Editorial display face for the /agents product page only. Space Grotesk is a
// geometric grotesk that reads colder and more technical than Bricolage at large
// sizes, so /agents gets its own big-type voice without echoing the landing.
// Loaded site-wide via the html var, but only /agents opts in via font-grotesk.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://q402.quackai.ai"),
  title: "Q402 | Gasless Payments on EVM | Quack AI",
  description:
    "Q402 is a gasless payment protocol for EVM chains. Your users pay zero gas. You sponsor it, invisibly and instantly.",
  openGraph: {
    title: "Q402 Agentic Wallet | Gasless payments for AI agents",
    description: "Gasless, bounded-spend wallets for AI agents. One signature, any EVM chain. MCP-native.",
    siteName: "Quack AI",
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Q402 Agentic Wallet | Gasless payments for AI agents",
    description: "Gasless, bounded-spend wallets for AI agents. One signature, any EVM chain. MCP-native.",
    images: ["/opengraph-image"],
  },
};

// Explicit viewport so phones render at device width (not a zoomed-out
// desktop). No maximumScale/userScalable lock — pinch-zoom stays enabled
// for accessibility.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${poppins.variable} ${jetbrainsMono.variable} ${bricolage.variable} ${spaceGrotesk.variable}`}>
      <body className="font-poppins antialiased bg-navy text-white">
        <ReferralCapture />
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
