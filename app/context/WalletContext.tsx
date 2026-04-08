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
  /** Sign an arbitrary message with the connected wallet (personal_sign). */
  signMessage: (message: string) => Promise<string | null>;
}

const WalletContext = createContext<WalletCtx>({
  address: null,
  isConnected: false,
  isPaidUser: false,
  connect: async () => {},
  connectWith: async () => {},
  disconnect: () => {},
  signMessage: async () => null,
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

  /**
   * Sign a message with the connected wallet using personal_sign.
   * Returns the hex signature, or null if the user rejects or no wallet present.
   * Tries MetaMask first, falls back to OKX.
   */
  const signMessage = useCallback(async (message: string): Promise<string | null> => {
    type EthProvider = { request: (args: { method: string; params: unknown[] }) => Promise<string> };
    const eth = (window as unknown as { ethereum?: EthProvider }).ethereum;
    const okx = (window as unknown as { okxwallet?: EthProvider }).okxwallet;
    const provider = eth ?? okx;
    if (!provider || !address) return null;
    try {
      return await provider.request({
        method: "personal_sign",
        params: [message, address],
      });
    } catch {
      return null;
    }
  }, [address]);

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
      signMessage,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
