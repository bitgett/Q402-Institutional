"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { connectWallet, getConnectedAccount } from "../lib/wallet";
import { isPaid, setPaid } from "../lib/access";

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
  const [isPaidUser, setIsPaidUser] = useState(false);
  const [mounted, setMounted] = useState(false);

  // 주소가 세팅되면 온체인 결제 여부 자동 확인
  const checkAndActivate = useCallback(async (addr: string) => {
    // 이미 로컬에서 paid 확인된 경우 스킵
    if (isPaid(addr)) {
      setIsPaidUser(true);
      return;
    }
    try {
      const res = await fetch("/api/payment/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr }),
      });
      const data = await res.json();
      if (data.status === "activated" || data.status === "already_active") {
        setPaid(addr);
        setIsPaidUser(true);
      }
    } catch {
      // 네트워크 오류 — 무시
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setIsPaidUser(false);
    localStorage.removeItem("q402_wallet");
  }, []);

  const connect = useCallback(async () => {
    const addr = await connectWallet("auto");
    if (addr) {
      setAddress(addr);
      localStorage.setItem("q402_wallet", addr);
      await checkAndActivate(addr);
    }
  }, [checkAndActivate]);

  const connectWith = useCallback(async (type: "metamask" | "okx") => {
    const addr = await connectWallet(type);
    if (addr) {
      setAddress(addr);
      localStorage.setItem("q402_wallet", addr);
      await checkAndActivate(addr);
    }
  }, [checkAndActivate]);

  // Restore on mount — localStorage + actual wallet state
  // setMounted(true) is called AFTER getConnectedAccount resolves
  // to prevent dashboard from seeing isConnected=false mid-init
  useEffect(() => {
    const init = async () => {
      const saved = localStorage.getItem("q402_wallet");
      if (saved) {
        setAddress(saved);
        if (isPaid(saved)) setIsPaidUser(true);
      }
      const addr = await getConnectedAccount();
      if (addr) {
        setAddress(addr);
        localStorage.setItem("q402_wallet", addr);
        checkAndActivate(addr);
      } else if (saved) {
        setAddress(null);
        setIsPaidUser(false);
        localStorage.removeItem("q402_wallet");
      }
      setMounted(true);
    };
    init();
  }, [checkAndActivate]);

  // Listen for account changes
  useEffect(() => {
    const eth = (window as unknown as { ethereum?: { on: (e: string, cb: (accounts: string[]) => void) => void; removeListener: (e: string, cb: (accounts: string[]) => void) => void } }).ethereum;
    if (!eth) return;
    const handler = (accounts: string[]) => {
      if (accounts.length === 0) { disconnect(); }
      else {
        setAddress(accounts[0]);
        checkAndActivate(accounts[0]);
      }
    };
    eth.on("accountsChanged", handler);
    return () => eth.removeListener("accountsChanged", handler);
  }, [disconnect, checkAndActivate]);

  return (
    <WalletContext.Provider value={{ address, isConnected: mounted && !!address, isPaidUser, connect, connectWith, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
