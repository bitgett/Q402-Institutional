import { Interface, parseEther, parseUnits } from "ethers";

type EthProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type WindowWithWallets = typeof window & {
  ethereum?: EthProvider & { isMetaMask?: boolean };
  okxwallet?: EthProvider;
};

const ERC20 = new Interface(["function transfer(address to,uint256 amount) returns (bool)"]);

const WALLET_CHAINS = {
  bnb: {
    chainId: "0x38",
    chainName: "BNB Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed1.binance.org/"],
    blockExplorerUrls: ["https://bscscan.com"],
  },
  eth: {
    chainId: "0x1",
    chainName: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum.publicnode.com"],
    blockExplorerUrls: ["https://etherscan.io"],
  },
  mantle: {
    chainId: "0x1388",
    chainName: "Mantle",
    nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
    rpcUrls: ["https://rpc.mantle.xyz"],
    blockExplorerUrls: ["https://mantlescan.xyz"],
  },
  injective: {
    chainId: "0x6f0",
    chainName: "Injective EVM",
    nativeCurrency: { name: "INJ", symbol: "INJ", decimals: 18 },
    rpcUrls: ["https://sentry.evm-rpc.injective.network/"],
    blockExplorerUrls: ["https://blockscout.injective.network"],
  },
  avax: {
    chainId: "0xa86a",
    chainName: "Avalanche C-Chain",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: ["https://api.avax.network/ext/bc/C/rpc"],
    blockExplorerUrls: ["https://snowtrace.io"],
  },
  xlayer: {
    chainId: "0xc4",
    chainName: "X Layer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: ["https://rpc.xlayer.tech"],
    blockExplorerUrls: ["https://www.oklink.com/xlayer"],
  },
  stable: {
    chainId: "0x3dc",
    chainName: "Stable",
    nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
    rpcUrls: ["https://rpc.stable.xyz"],
    blockExplorerUrls: ["https://stable-explorer.io"],
  },
} as const;

export type WalletChainKey = keyof typeof WALLET_CHAINS;

function toQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function asProviderError(err: unknown): { code?: number; message?: string } {
  if (typeof err !== "object" || err === null) return {};
  const e = err as { code?: number; message?: string };
  return { code: e.code, message: e.message };
}

function getProvider(type: "metamask" | "okx" | "auto"): EthProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as WindowWithWallets;
  if (type === "okx")      return w.okxwallet ?? null;
  if (type === "metamask") return w.ethereum ?? null;
  return w.ethereum ?? w.okxwallet ?? null;
}

export function getActiveProvider(): EthProvider | null {
  if (typeof window === "undefined") return null;
  const savedType = localStorage.getItem("q402_wallet_type") as "metamask" | "okx" | null;
  if (savedType) return getProvider(savedType) ?? getProvider("auto");
  return getProvider("auto");
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

export function walletErrorMessage(err: unknown): string {
  const { code, message } = asProviderError(err);
  if (code === 4001) return "Wallet request was rejected.";
  if (message?.toLowerCase().includes("insufficient funds")) return "Insufficient balance for amount plus gas.";
  if (message?.toLowerCase().includes("user rejected")) return "Wallet request was rejected.";
  return message ?? "Wallet transaction failed.";
}

export async function ensureWalletChain(chain: WalletChainKey): Promise<void> {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet provider found.");
  const target = WALLET_CHAINS[chain];
  const current = await provider.request({ method: "eth_chainId" }) as string;
  if (current?.toLowerCase() === target.chainId.toLowerCase()) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: target.chainId }],
    });
  } catch (err) {
    const { code } = asProviderError(err);
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [target],
    });
  }
}

export async function sendNativeTransfer(args: {
  chain: WalletChainKey;
  from: string;
  to: string;
  amount: string;
}): Promise<string> {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet provider found.");
  await ensureWalletChain(args.chain);
  const value = parseEther(args.amount);
  return await provider.request({
    method: "eth_sendTransaction",
    params: [{
      from: args.from,
      to: args.to,
      value: toQuantity(value),
    }],
  }) as string;
}

export async function sendErc20Transfer(args: {
  chain: WalletChainKey;
  from: string;
  tokenAddress: string;
  to: string;
  amount: string;
  decimals: number;
}): Promise<string> {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet provider found.");
  await ensureWalletChain(args.chain);
  const amountAtomic = parseUnits(args.amount, args.decimals);
  const data = ERC20.encodeFunctionData("transfer", [args.to, amountAtomic]);
  return await provider.request({
    method: "eth_sendTransaction",
    params: [{
      from: args.from,
      to: args.tokenAddress,
      data,
    }],
  }) as string;
}

export async function waitForWalletReceipt(
  chain: WalletChainKey,
  txHash: string,
  timeoutMs = 180_000,
): Promise<void> {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet provider found.");
  await ensureWalletChain(chain);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }) as { status?: string } | null;
    if (receipt) {
      if (receipt.status && receipt.status !== "0x1") {
        throw new Error("Transaction reverted on-chain.");
      }
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error("Transaction submitted, but confirmation timed out. Paste the TX hash to verify manually.");
}
