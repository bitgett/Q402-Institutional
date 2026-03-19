"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { connectWallet, getConnectedAccount } from "../lib/wallet";

interface WalletCtx {
  address: string | null;
  isConnected: boolean;
  isPaidUser: boolean;
  connect: () => Promise<void>;
  connectWith: (type: "metamask" | "okx") => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletCtx>({
  address: null,
  isConnected: false,
  isPaidUser: false,
  connect: async () => {},
  connectWith: async () => {},
  disconnect: () => {},
});

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem("q402_wallet");
  }, []);

  const connect = useCallback(async () => {
    const addr = await connectWallet("auto");
    if (addr) {
      setAddress(addr);
      localStorage.setItem("q402_wallet", addr);
    }
  }, []);

  const connectWith = useCallback(async (type: "metamask" | "okx") => {
    const addr = await connectWallet(type);
    if (addr) {
      setAddress(addr);
      localStorage.setItem("q402_wallet", addr);
    }
  }, []);

  // Restore on mount
  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem("q402_wallet");
      if (saved) setAddress(saved);
      const addr = await getConnectedAccount();
      if (addr) {
        setAddress(addr);
        localStorage.setItem("q402_wallet", addr);
      } else if (saved) {
        setAddress(null);
        localStorage.removeItem("q402_wallet");
      }
      setMounted(true);
    };
    init();
  }, []);

  // Listen for account changes
  useEffect(() => {
    const eth = (window as unknown as { ethereum?: { on: (e: string, cb: (accounts: string[]) => void) => void; removeListener: (e: string, cb: (accounts: string[]) => void) => void } }).ethereum;
    if (!eth) return;
    const handler = (accounts: string[]) => {
      if (accounts.length === 0) { disconnect(); }
      else {
        setAddress(accounts[0]);
        localStorage.setItem("q402_wallet", accounts[0]);
      }
    };
    eth.on("accountsChanged", handler);
    return () => eth.removeListener("accountsChanged", handler);
  }, [disconnect]);

  // isPaidUser is always true — paywall removed
  return (
    <WalletContext.Provider value={{
      address,
      isConnected: mounted && !!address,
      isPaidUser: true,
      connect,
      connectWith,
      disconnect,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
