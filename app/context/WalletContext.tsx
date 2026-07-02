"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  connectWallet,
  getConnectedAccount,
  getActiveProvider,
  type WalletType,
} from "../lib/wallet";

interface WalletCtx {
  address: string | null;
  isConnected: boolean;
  connect: () => Promise<void>;
  connectWith: (type: WalletType) => Promise<string | null>;
  disconnect: () => void;
  /** Sign an arbitrary message with the connected wallet (personal_sign). */
  signMessage: (message: string) => Promise<string | null>;
  /** Sign EIP-712 typed data with the connected wallet (eth_signTypedData_v4). */
  signTypedData: (typedData: unknown) => Promise<string | null>;
}

const WalletContext = createContext<WalletCtx>({
  address: null,
  isConnected: false,
  connect: async () => {},
  connectWith: async () => null,
  disconnect: () => {},
  signMessage: async () => null,
  signTypedData: async () => null,
});

type EvProvider = {
  on: (e: string, cb: (a: string[]) => void) => void;
  removeListener: (e: string, cb: (a: string[]) => void) => void;
};

// Collect every distinct injected provider we know about, so accountsChanged
// fires regardless of which one the user picked. Providers from the same
// vendor that appear in both window.ethereum AND window.ethereum.providers[]
// are deduped by reference.
function listInjectedProviders(): EvProvider[] {
  const w = window as unknown as {
    ethereum?: EvProvider & { providers?: EvProvider[] };
    okxwallet?: EvProvider;
    BinanceChain?: EvProvider;
    coinbaseWalletExtension?: EvProvider;
    bitkeep?: { ethereum?: EvProvider };
  };
  const set = new Set<EvProvider>();
  if (w.ethereum) set.add(w.ethereum);
  if (Array.isArray(w.ethereum?.providers)) {
    for (const p of w.ethereum.providers) if (p) set.add(p);
  }
  if (w.okxwallet) set.add(w.okxwallet);
  if (w.BinanceChain) set.add(w.BinanceChain);
  if (w.coinbaseWalletExtension) set.add(w.coinbaseWalletExtension);
  if (w.bitkeep?.ethereum) set.add(w.bitkeep.ethereum);
  return Array.from(set);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  // walletType is only needed to bias getActiveProvider's lookup, which
  // reads localStorage directly — no React state needed.

  // Explicit-disconnect sentinel. EIP-1193 wallets don't revoke the
  // dapp's `eth_accounts` permission on disconnect — that permission
  // is granted via `eth_requestAccounts` and lives in the wallet
  // extension's own state. So after the user clicks "Sign out", the
  // disconnect handler clears our localStorage but the next
  // `eth_accounts` call (during init / after reload) still returns
  // the authorized address. The init useEffect would then re-save it
  // and the user is right back in the connected state — the "X
  // pressed, still connected" UX bug.
  //
  // Sentinel approach: disconnect() writes this key, init() short-
  // circuits when it sees the key, and connect/connectWith remove it
  // on a fresh user-initiated authorization. The key is intentionally
  // scoped to the browser tab's localStorage so a different machine /
  // private window is not blocked.
  const DISCONNECT_SENTINEL = "q402_wallet_explicit_disconnect";

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem("q402_wallet");
    localStorage.removeItem("q402_wallet_type");
    localStorage.setItem(DISCONNECT_SENTINEL, "1");
  }, []);

  const connect = useCallback(async () => {
    const addr = await connectWallet("auto");
    if (addr) {
      setAddress(addr);
      localStorage.setItem("q402_wallet", addr);
      localStorage.removeItem(DISCONNECT_SENTINEL);
    }
  }, []);

  const connectWith = useCallback(async (type: WalletType): Promise<string | null> => {
    const addr = await connectWallet(type);
    if (addr) {
      setAddress(addr);
      localStorage.setItem("q402_wallet", addr);
      localStorage.setItem("q402_wallet_type", type);
      localStorage.removeItem(DISCONNECT_SENTINEL);
    }
    return addr;
  }, []);

  /**
   * Sign a message with the connected wallet using personal_sign. Routes
   * through getActiveProvider() so the signature comes from the same
   * vendor the user originally picked, even when several wallet
   * extensions are installed side by side.
   */
  const signMessage = useCallback(async (message: string): Promise<string | null> => {
    if (!address) return null;
    const provider = getActiveProvider() as
      | { request: (a: { method: string; params: unknown[] }) => Promise<string> }
      | null;
    if (!provider) return null;
    try {
      return await provider.request({
        method: "personal_sign",
        params: [message, address],
      });
    } catch {
      return null;
    }
  }, [address]);

  /**
   * Sign EIP-712 typed data with eth_signTypedData_v4. Same getActiveProvider()
   * routing as signMessage so the signature comes from the vendor the user
   * picked. Used for escrow release/dispute (a vault-domain typed-data sig);
   * returns null if no wallet or the user rejects.
   */
  const signTypedData = useCallback(async (typedData: unknown): Promise<string | null> => {
    if (!address) return null;
    const provider = getActiveProvider() as
      | { request: (a: { method: string; params: unknown[] }) => Promise<string> }
      | null;
    if (!provider) return null;
    try {
      return await provider.request({
        method: "eth_signTypedData_v4",
        params: [address, typeof typedData === "string" ? typedData : JSON.stringify(typedData)],
      });
    } catch {
      return null;
    }
  }, [address]);

  // Restore on mount
  useEffect(() => {
    const init = async () => {
      // Sentinel honored before anything else: an explicit disconnect
      // must survive a reload. Without this check the eth_accounts
      // probe below would happily re-authorize from the wallet's
      // standing permission grant, undoing the user's intent.
      if (localStorage.getItem(DISCONNECT_SENTINEL)) {
        setMounted(true);
        return;
      }
      const saved = localStorage.getItem("q402_wallet");
      // Immediately restore from localStorage so pages don't flash "disconnected"
      if (saved) setAddress(saved);
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

  // Listen for account changes across every injected provider. Vendors
  // that won the window.ethereum slot AND vendors that only expose a
  // namespaced global both need to be subscribed — otherwise a disconnect
  // in (e.g.) Binance Web3 Wallet wouldn't propagate to our context.
  useEffect(() => {
    const handler = (accounts: string[]) => {
      if (accounts.length === 0) { disconnect(); }
      else {
        setAddress(accounts[0]);
        localStorage.setItem("q402_wallet", accounts[0]);
        // Clear the explicit-disconnect sentinel so the next reload's
        // init useEffect auto-restores the wallet normally. Without
        // this, a user who clicks our Sign Out (sentinel set) and
        // then re-permissions the dapp via the wallet extension's own
        // UI would see the wallet connected for this session but
        // silently disconnected after the next reload — same UX bug
        // the sentinel was added to prevent, just on a different
        // reconnect path.
        localStorage.removeItem(DISCONNECT_SENTINEL);
      }
    };
    const providers = listInjectedProviders();
    for (const p of providers) p.on("accountsChanged", handler);
    return () => { for (const p of providers) p.removeListener("accountsChanged", handler); };
  }, [disconnect]);

  return (
    <WalletContext.Provider value={{
      address,
      isConnected: mounted && !!address,
      connect,
      connectWith,
      disconnect,
      signMessage,
      signTypedData,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
