// Verify Chainlink Data Feed addresses for the CCIP USD conversion.
// For each (chain, address, expected pair) it reads description() / decimals()
// / latestRoundData() over a public RPC so a wrong address can't slip in.
import { JsonRpcProvider, Contract } from "ethers";

const RPC = {
  eth: "https://ethereum-rpc.publicnode.com",
  avax: "https://api.avax.network/ext/bc/C/rpc",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};

// The exact feeds the CCIP quote route reads (LINK price is global, so the
// avax LINK fee is priced off Ethereum's LINK/USD feed). [chain, kind, address,
// expectedDescription]
const FEEDS = [
  ["eth", "LINK", "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c", "LINK / USD"],
  ["eth", "native(ETH)", "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", "ETH / USD"],
  ["arbitrum", "LINK", "0x86E53CF1B870786351Da77A57575e79CB55812CB", "LINK / USD"],
  ["arbitrum", "native(ETH)", "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", "ETH / USD"],
  ["avax", "native(AVAX)", "0x0A77230d17318075983913bC2145DB16C7366156", "AVAX / USD"],
];

const ABI = [
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
];

const providers = Object.fromEntries(
  Object.entries(RPC).map(([k, url]) => [k, new JsonRpcProvider(url)]),
);

let allOk = true;
for (const [chain, kind, addr, expected] of FEEDS) {
  try {
    const c = new Contract(addr.toLowerCase(), ABI, providers[chain]);
    const [desc, dec, round] = await Promise.all([
      c.description(),
      c.decimals(),
      c.latestRoundData(),
    ]);
    const answer = round[1];
    const updatedAt = Number(round[3]);
    const price = Number(answer) / 10 ** Number(dec);
    const ageMin = Math.round((Date.now() / 1000 - updatedAt) / 60);
    const match = desc.trim() === expected ? "OK" : `MISMATCH (expected ${expected})`;
    if (match !== "OK") allOk = false;
    console.log(
      `${chain.padEnd(8)} ${kind.padEnd(12)} ${addr}  desc="${desc}" dec=${dec} price=$${price.toFixed(2)} age=${ageMin}m  ${match}`,
    );
  } catch (e) {
    allOk = false;
    console.log(`${chain.padEnd(8)} ${kind.padEnd(12)} ${addr}  ERROR ${e.shortMessage ?? e.message}`);
  }
}
console.log(allOk ? "\nALL FEEDS OK" : "\nSOME FEEDS FAILED");
