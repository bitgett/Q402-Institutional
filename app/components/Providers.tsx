"use client";

import { WalletProvider } from "../context/WalletContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
