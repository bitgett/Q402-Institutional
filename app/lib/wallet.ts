type EthProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type WindowWithWallets = typeof window & {
  ethereum?: EthProvider & { isMetaMask?: boolean };
  okxwallet?: EthProvider;
};

function getProvider(type: "metamask" | "okx" | "auto"): EthProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as WindowWithWallets;
  if (type === "okx")      return w.okxwallet ?? null;
  if (type === "metamask") return w.ethereum ?? null;
  return w.ethereum ?? w.okxwallet ?? null;
}

export async function connectWallet(type: "metamask" | "okx" | "auto" = "auto"): Promise<string | null> {
  const provider = getProvider(type);
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export async function getConnectedAccount(): Promise<string | null> {
  const provider = getProvider("auto");
  if (!provider) return null;
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export function isWalletInstalled(type: "metamask" | "okx"): boolean {
  if (typeof window === "undefined") return false;
  const w = window as WindowWithWallets;
  if (type === "okx")      return !!w.okxwallet;
  if (type === "metamask") return !!w.ethereum;
  return false;
}
