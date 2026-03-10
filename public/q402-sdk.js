/**
 * Q402 Client SDK (browser-compatible)
 * Handles EIP-712 witness signing + EIP-7702 authorization signing.
 *
 * Usage:
 *   const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
 *   const result = await q402.pay({ to: "0x...", amount: "5.00", token: "USDC" });
 */

const Q402_CHAIN_CONFIG = {
  avax: {
    name: "Avalanche",
    chainId: 43114,
    implContract: "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
  },
};

const Q402_WITNESS_TYPES = {
  PaymentWitness: [
    { name: "owner",     type: "address" },
    { name: "token",     type: "address" },
    { name: "amount",    type: "uint256" },
    { name: "to",        type: "address" },
    { name: "deadline",  type: "uint256" },
    { name: "paymentId", type: "bytes32" },
  ],
};

class Q402Client {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey   - Your Q402 API key (q402_live_xxx)
   * @param {"avax"} opts.chain    - Target chain (avax supported)
   * @param {string} [opts.relayUrl] - Override relay endpoint (default: https://q402.io/api/relay)
   */
  constructor({ apiKey, chain = "avax", relayUrl = "https://q402.io/api/relay" }) {
    this.apiKey = apiKey;
    this.chain = chain;
    this.relayUrl = relayUrl;
    this.chainCfg = Q402_CHAIN_CONFIG[chain];
    if (!this.chainCfg) throw new Error(`Unsupported chain: ${chain}`);
  }

  /**
   * Make a gasless token payment.
   *
   * @param {object} opts
   * @param {string} opts.to       - Recipient address
   * @param {string} opts.amount   - Human-readable amount e.g. "5.00"
   * @param {"USDC"|"USDT"} opts.token
   * @param {string} [opts.paymentId] - Optional unique ID (auto-generated if omitted)
   * @returns {Promise<{success, txHash, blockNumber, tokenAmount, token, chain}>}
   */
  async pay({ to, amount, token = "USDC", paymentId }) {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const owner = await signer.getAddress();

    const tokenCfg = this.chainCfg[token.toLowerCase()];
    if (!tokenCfg) throw new Error(`Unsupported token: ${token}`);

    // Convert human-readable amount → atomic units
    const decimals = tokenCfg.decimals;
    const amountRaw = BigInt(Math.round(parseFloat(amount) * 10 ** decimals)).toString();

    // Deadline: 10 minutes from now
    const deadline = Math.floor(Date.now() / 1000) + 600;

    // paymentId: random bytes32 if not provided
    const pid = paymentId ?? ethers.hexlify(ethers.randomBytes(32));

    // ── 1. EIP-712 witness signature ──────────────────────────────────────────
    const domain = {
      name: "Q402PaymentImplementation",
      version: "1",
      chainId: this.chainCfg.chainId,
      verifyingContract: this.chainCfg.implContract,
    };

    const witnessSig = await signer.signTypedData(
      domain,
      Q402_WITNESS_TYPES,
      {
        owner,
        token: tokenCfg.address,
        amount: BigInt(amountRaw),
        to,
        deadline: BigInt(deadline),
        paymentId: pid,
      }
    );

    // ── 2. EIP-7702 authorization ─────────────────────────────────────────────
    // The owner signs an authorization to temporarily delegate their EOA
    // to run Q402PaymentImplementation bytecode.
    const nonce = await provider.getTransactionCount(owner);
    const authorization = await this._signAuthorization(signer, {
      chainId: this.chainCfg.chainId,
      address: this.chainCfg.implContract,
      nonce,
    });

    // ── 3. Call relay API ─────────────────────────────────────────────────────
    const resp = await fetch(this.relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey:        this.apiKey,
        chain:         this.chain,
        token,
        from:          owner,
        to,
        amount:        amountRaw,
        deadline,
        paymentId:     pid,
        witnessSig,
        authorization,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? "Relay failed");
    return data;
  }

  /**
   * Sign an EIP-7702 authorization using eth_signTypedData_v4.
   * Most wallets support this via the MetaMask-compatible JSON-RPC method.
   */
  async _signAuthorization(signer, { chainId, address, nonce }) {
    // EIP-7702 auth is signed as typed data:
    // keccak256(MAGIC || rlp([chainId, address, nonce]))
    // For wallet compatibility we use eth_signTypedData_v4 with a custom type.
    const domain = { name: "EIP7702Authorization", version: "1", chainId };
    const types = {
      Authorization: [
        { name: "address", type: "address" },
        { name: "nonce",   type: "uint256" },
      ],
    };
    const value = { address, nonce };

    const sig = await signer.signTypedData(domain, types, value);

    // Parse r, s, v from the 65-byte signature
    const r = sig.slice(0, 66);
    const s = "0x" + sig.slice(66, 130);
    const v = parseInt(sig.slice(130, 132), 16);
    const yParity = v === 27 ? 0 : 1;

    return { chainId, address, nonce, yParity, r, s };
  }
}

// Export for ESM / CommonJS / browser globals
if (typeof module !== "undefined") module.exports = { Q402Client };
if (typeof window !== "undefined") window.Q402Client = Q402Client;
