import type { Metadata } from "next";
import { Poppins, JetBrains_Mono, Bricolage_Grotesque } from "next/font/google";
import "./globals.css";
import Providers from "./components/Providers";

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

export const metadata: Metadata = {
  metadataBase: new URL("https://q402.quackai.ai"),
  title: "Q402 | Gasless Payments on EVM | Quack AI",
  description:
    "Q402 is a gasless payment protocol for EVM chains. Your users pay zero gas. You sponsor it, invisibly and instantly.",
  openGraph: {
    title: "Q402 | Gasless Payments on EVM",
    description: "Your users pay zero gas. Powered by EIP-712 + EIP-7702.",
    siteName: "Quack AI",
    images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Q402 | Gasless Payments on EVM",
    description: "Your users pay zero gas. Powered by EIP-712 + EIP-7702.",
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${poppins.variable} ${jetbrainsMono.variable} ${bricolage.variable}`}>
      <body className="font-poppins antialiased bg-navy text-white">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
