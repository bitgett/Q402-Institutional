import type { Metadata } from "next";
import "./globals.css";
import Providers from "./components/Providers";

export const metadata: Metadata = {
  title: "Q402 | Gasless Payments on EVM | Quack AI",
  description:
    "Q402 is a gasless payment protocol for EVM chains. Your users pay zero gas. You sponsor it, invisibly and instantly.",
  openGraph: {
    title: "Q402 | Gasless Payments on EVM",
    description: "Your users pay zero gas. Powered by EIP-712 + EIP-7702.",
    siteName: "Quack AI",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-poppins antialiased bg-navy text-white">
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
