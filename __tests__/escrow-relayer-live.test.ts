/**
 * LIVE integration test against the deployed Sepolia escrow. Skipped unless
 * ESCROW_RELAYER_KEY is set (so it never runs in normal CI). Verifies the real
 * escrow-relayer functions end-to-end: settleEscrowLock (7702, client-serialized
 * authorization) -> settleEscrowRelease. Run:
 *   ESCROW_RELAYER_KEY=0x.. ESCROW_ENABLED=1 npx vitest run __tests__/escrow-relayer-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { getEscrowChain } from "@/app/lib/escrow-contracts";
import { escrowFacilitator, settleEscrowLock, settleEscrowRelease } from "@/app/lib/escrow-relayer";

const KEY = process.env.ESCROW_RELAYER_KEY;
const MOCK_ABI = ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"];
const VAULT_READ = ["function getEscrow(bytes32) view returns ((address buyer,address seller,address token,uint256 amount,uint256 releaseDeadline,address arbiter,uint8 state))"];
const LOCK_TYPES = { EscrowLock: [
  { name: "buyer", type: "address" }, { name: "seller", type: "address" }, { name: "vault", type: "address" },
  { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "salt", type: "bytes32" },
  { name: "releaseDeadline", type: "uint256" }, { name: "arbiter", type: "address" }, { name: "facilitator", type: "address" },
  { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
] };
const RELEASE_TYPES = { EscrowRelease: [
  { name: "escrowId", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
] };

describe.skipIf(!KEY)("escrow-relayer live (Sepolia)", () => {
  it("locks via settleEscrowLock (7702) then settles via settleEscrowRelease", async () => {
    const cfg = getEscrowChain("sepolia")!;
    const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId);
    const relayer = new ethers.Wallet(KEY!.startsWith("0x") ? KEY! : `0x${KEY}`, provider);
    const buyer = ethers.Wallet.createRandom().connect(provider);
    const seller = ethers.Wallet.createRandom();
    const amount = ethers.parseUnits("1", 6);

    // fund the buyer with mock USDC (mint is public on the test token)
    const usdc = new ethers.Contract(cfg.tokens.USDC, MOCK_ABI, relayer);
    await (await usdc.mint(buyer.address, amount)).wait();

    const now = Math.floor(Date.now() / 1000);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const p = {
      buyer: buyer.address, seller: seller.address, vault: cfg.vault, token: cfg.tokens.USDC,
      amount: amount.toString(), salt, releaseDeadline: String(now + 3600), arbiter: ethers.ZeroAddress,
      facilitator: escrowFacilitator("sepolia")!, nonce: "1", deadline: String(now + 900),
    };
    const lockSig = await buyer.signTypedData(
      { name: cfg.lockDomainName, version: "1", chainId: cfg.chainId, verifyingContract: buyer.address }, LOCK_TYPES, p);
    const a = await buyer.authorize({ address: cfg.lockImpl });
    const auth = { chainId: Number(a.chainId), address: a.address, nonce: Number(a.nonce),
      yParity: a.signature.yParity, r: a.signature.r, s: a.signature.s };

    const lock = await settleEscrowLock("sepolia", p, lockSig, auth);
    expect(lock.ok, "lock failed: " + (lock.ok ? "" : lock.error)).toBe(true);

    const escrowId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [buyer.address, salt]));
    const vault = new ethers.Contract(cfg.vault, VAULT_READ, provider);
    expect(Number((await vault.getEscrow(escrowId)).state)).toBe(1); // Open

    const deadline = String(now + 900);
    const relSig = await buyer.signTypedData(
      { name: cfg.vaultDomainName, version: "1", chainId: cfg.chainId, verifyingContract: cfg.vault }, RELEASE_TYPES,
      { escrowId, nonce: 2, deadline });
    const rel = await settleEscrowRelease("sepolia", escrowId, "2", deadline, relSig);
    expect(rel.ok, "release failed: " + (rel.ok ? "" : rel.error)).toBe(true);

    expect(await new ethers.Contract(cfg.tokens.USDC, MOCK_ABI, provider).balanceOf(seller.address)).toBe(amount);
  }, 180_000);
});
