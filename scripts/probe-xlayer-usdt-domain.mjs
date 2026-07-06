import { ethers } from "ethers";
const RPC = "https://rpc.xlayer.tech";
const USDT = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const RELAYER = "0xfc77ff29178b7286a8ba703d7a70895ca74ff466";
const onchainDS = "0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d";

const p = new ethers.JsonRpcProvider(RPC);
const net = await p.getNetwork();
console.log("chainId:", net.chainId.toString());

// EIP-712 domain candidates (name from contract = "USD₮0"; version unknown -> try "1")
function ds(name, version) {
  return ethers.TypedDataEncoder.hashDomain({ name, version, chainId: 196, verifyingContract: USDT });
}
for (const [n, v] of [["USD₮0", "1"], ["USD₮0", "2"], ["USDT0", "1"], ["USD₮0", "0"]]) {
  const h = ds(n, v);
  console.log(`domain name="${n}" version="${v}" => ${h} ${h.toLowerCase() === onchainDS.toLowerCase() ? "<<< MATCH" : ""}`);
}

// relayer gas (OKB) on X Layer
const bal = await p.getBalance(RELAYER);
console.log("\nrelayer", RELAYER, "OKB balance:", ethers.formatEther(bal));
