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

type EthProvider = { request: (args: { method: string; params: unknown[] }) => Promise<string> };

function getProviders() {
  const w = window as unknown as { ethereum?: EthProvider; okxwallet?: EthProvider };
  return { eth: w.ethereum, okx: w.okxwallet };
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [walletType, setWalletType] = useState<"metamask" | "okx" | null>(null);

  const disconnect = useCallback(() => {
    setAddress(null);
    setWalletType(null);
    localStorage.removeItem("q402_wallet");
    localStorage.removeItem("q402_wallet_type");
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
      setWalletType(type);
      localStorage.setItem("q402_wallet", addr);
      localStorage.setItem("q402_wallet_type", type);
    }
  }, []);

  /**
   * Sign a message with the connected wallet using personal_sign.
   * Uses the same wallet type that was used to connect.
   */
  const signMessage = useCallback(async (message: string): Promise<string | null> => {
    if (!address) return null;
    const { eth, okx } = getProviders();
    // Use whichever wallet the user connected with; fall back to whatever is available
    const savedType = walletType ?? (localStorage.getItem("q402_wallet_type") as "metamask" | "okx" | null);
    let provider: EthProvider | undefined;
    if (savedType === "okx") provider = okx ?? eth;
    else if (savedType === "metamask") provider = eth ?? okx;
    else provider = eth ?? okx;
    if (!provider) return null;
    try {
      return await provider.request({
        method: "personal_sign",
        params: [message, address],
      });
    } catch {
      return null;
    }
  }, [address, walletType]);

  // Restore on mount
  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem("q402_wallet");
      const savedType = localStorage.getItem("q402_wallet_type") as "metamask" | "okx" | null;
      // Immediately restore from localStorage so pages don't flash "disconnected"
      if (saved) setAddress(saved);
      if (savedType) setWalletType(savedType);
      // Verify wallet is still connected — but only update, never clear from here.
      // The accountsChanged event (empty array) handles actual disconnections.
      // Clearing from init causes wallet to flash-disconnect on page navigation.
      const addr = await getConnectedAccount();
      if (addr) {
        setAddress(addr);
        localStorage.setItem("q402_wallet", addr);
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
