/**
 * Q402 Client SDK (browser-compatible)
 * v1.2.0 — Multi-chain: EIP-7702 (avax/bnb/eth/xlayer) + EIP-3009 (xlayer fallback)
 *
 * 체인별 서명 방식:
 *   avax / bnb / eth  → EIP-712 PaymentWitness + EIP-7702 authorization (2 sigs)
 *   xlayer            → EIP-712 TransferAuthorization + EIP-7702 authorization (2 sigs)
 *                       domain verifyingContract = user's EOA (not impl contract)
 *                       impl: 0x31E9D105df96b5294298cFaffB7f106994CD0d0f
 *
 * Usage:
 *   const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
 *   const result = await q402.pay({ to: "0x...", amount: "5.00", token: "USDC" });
 *
 *   const q402xl = new Q402Client({ apiKey: "q402_live_xxx", chain: "xlayer" });
 *   const result = await q402xl.pay({ to: "0x...", amount: "1.00", token: "USDC" });
 */

const Q402_CHAIN_CONFIG = {
  avax: {
    name:         "Avalanche",
    chainId:      43114,
    mode:         "eip7702",
    implContract: "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
  },
  bnb: {
    name:         "BNB Chain",
    chainId:      56,
    mode:         "eip7702",
    implContract: "0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6",
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  },
  eth: {
    name:         "Ethereum",
    chainId:      1,
    mode:         "eip7702",
    implContract: "0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    usdt: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  },
  xlayer: {
    name:         "X Layer",
    chainId:      196,
    mode:         "eip7702_xlayer",  // EIP-7702 지원 확인됨 (2026-03-12)
    implContract: "0x31E9D105df96b5294298cFaffB7f106994CD0d0f",
    usdc: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
    usdt: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
  },
};

// EIP-7702 모드 EIP-712 타입
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

// EIP-3009 모드 (X Layer USDC TransferWithAuthorization 타입) — fallback only
const Q402_EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
};

// EIP-7702 X Layer 모드 — Q402PaymentImplementationXLayer witness 타입
// verifyingContract = user's EOA (address(this) under delegation)
// nonce = uint256 (random, replay protection via usedNonces mapping)
const Q402_XLAYER_TRANSFER_TYPES = {
  TransferAuthorization: [
    { name: "owner",       type: "address" },
    { name: "facilitator", type: "address" },
    { name: "token",       type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "uint256" },
    { name: "deadline",    type: "uint256" },
  ],
};

class Q402Client {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey     - Your Q402 API key (q402_live_xxx)
   * @param {"avax"|"bnb"|"eth"|"xlayer"} opts.chain - Target chain
   * @param {string} [opts.relayUrl] - Override relay endpoint (default: https://q402.io/api/relay)
   */
  constructor({ apiKey, chain = "avax", relayUrl = "https://q402.io/api/relay" }) {
    this.apiKey   = apiKey;
    this.chain    = chain;
    this.relayUrl = relayUrl;
    this.chainCfg = Q402_CHAIN_CONFIG[chain];
    if (!this.chainCfg) throw new Error(`Unsupported chain: ${chain}. Supported: avax, bnb, eth, xlayer`);
  }

  /**
   * Make a gasless token payment.
   *
   * @param {object} opts
   * @param {string} opts.to          - Recipient address
   * @param {string} opts.amount      - Human-readable amount e.g. "5.00"
   * @param {"USDC"|"USDT"} opts.token
   * @param {string} [opts.paymentId] - Optional unique ID (auto-generated if omitted)
   * @returns {Promise<{success, txHash, blockNumber, tokenAmount, token, chain, method}>}
   */
  async pay({ to, amount, token = "USDC", paymentId }) {
    const ethereum = window.ethereum || window.okxwallet;
    if (!ethereum) throw new Error("No Web3 wallet found. Install MetaMask or OKX Wallet.");

    const provider = new ethers.BrowserProvider(ethereum);
    const signer   = await provider.getSigner();
    const owner    = await signer.getAddress();

    const tokenCfg = this.chainCfg[token.toLowerCase()];
    if (!tokenCfg) throw new Error(`Unsupported token: ${token} on chain ${this.chain}`);

    const decimals  = tokenCfg.decimals;
    const amountRaw = BigInt(Math.round(parseFloat(amount) * 10 ** decimals)).toString();
    const deadline  = Math.floor(Date.now() / 1000) + 600; // +10분
    const pid       = paymentId ?? ethers.hexlify(ethers.randomBytes(32));

    if (this.chainCfg.mode === "eip7702_xlayer") {
      return this._payXLayerEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg);
    } else if (this.chainCfg.mode === "eip3009") {
      return this._payEIP3009(signer, owner, to, amountRaw, deadline, token, tokenCfg);
    } else {
      return this._payEIP7702(signer, provider, owner, to, amountRaw, deadline, pid, token, tokenCfg);
    }
  }

  // ── EIP-7702 결제 (avax / bnb / eth) ─────────────────────────────────────────
  async _payEIP7702(signer, provider, owner, to, amountRaw, deadline, pid, token, tokenCfg) {
    // 1. EIP-712 witness 서명
    const domain = {
      name:              "Q402PaymentImplementation",
      version:           "1",
      chainId:           this.chainCfg.chainId,
      verifyingContract: this.chainCfg.implContract,
    };

    const witnessSig = await signer.signTypedData(domain, Q402_WITNESS_TYPES, {
      owner,
      token:     tokenCfg.address,
      amount:    BigInt(amountRaw),
      to,
      deadline:  BigInt(deadline),
      paymentId: pid,
    });

    // 2. EIP-7702 authorization 서명
    const nonce         = await provider.getTransactionCount(owner);
    const authorization = await this._signAuthorization(signer, {
      chainId: this.chainCfg.chainId,
      address: this.chainCfg.implContract,
      nonce,
    });

    // 3. Relay API 호출
    const resp = await fetch(this.relayUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        apiKey:       this.apiKey,
        chain:        this.chain,
        token,
        from:         owner,
        to,
        amount:       amountRaw,
        deadline,
        paymentId:    pid,
        witnessSig,
        authorization,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? "Relay failed");
    return data;
  }

  // ── EIP-7702 XLayer 결제 ──────────────────────────────────────────────────────
  // Q402PaymentImplementationXLayer.transferWithAuthorization() 사용
  // witness type: TransferAuthorization (domain verifyingContract = user's EOA)
  // facilitator = relayer wallet (msg.sender check on-chain)
  async _payXLayerEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg) {
    // 1. Relay 서버에서 facilitator 주소 조회
    const infoUrl = this.relayUrl.replace(/\/relay$/, "/relay/info");
    const infoResp = await fetch(infoUrl);
    if (!infoResp.ok) throw new Error("Failed to fetch relay facilitator info");
    const { facilitator } = await infoResp.json();

    // 2. EIP-712 TransferAuthorization 서명
    //    verifyingContract = owner's EOA (address(this) under EIP-7702 delegation)
    const domain = {
      name:              "Q402 X Layer",
      version:           "1",
      chainId:           this.chainCfg.chainId,
      verifyingContract: owner,  // ← user's own EOA, NOT impl contract
    };

    // random uint256 nonce (replay protection via usedNonces mapping in contract)
    const nonceBuf    = ethers.randomBytes(32);
    const xlayerNonce = ethers.toBigInt(nonceBuf);

    const witnessSig = await signer.signTypedData(domain, Q402_XLAYER_TRANSFER_TYPES, {
      owner,
      facilitator,
      token:     tokenCfg.address,
      recipient: to,
      amount:    BigInt(amountRaw),
      nonce:     xlayerNonce,
      deadline:  BigInt(deadline),
    });

    // 3. EIP-7702 authorization 서명 (impl contract 위임)
    const authNonce    = await provider.getTransactionCount(owner);
    const authorization = await this._signAuthorization(signer, {
      chainId: this.chainCfg.chainId,
      address: this.chainCfg.implContract,
      nonce:   authNonce,
    });

    // 4. Relay API 호출
    const resp = await fetch(this.relayUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        apiKey:       this.apiKey,
        chain:        this.chain,
        token,
        from:         owner,
        to,
        amount:       amountRaw,
        deadline,
        witnessSig,
        authorization,
        xlayerNonce:  xlayerNonce.toString(),
        facilitator,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? "Relay failed");
    return data;
  }

  // ── EIP-3009 결제 (xlayer 레거시 fallback, 내부용) ────────────────────────────
  // USDC의 TransferWithAuthorization 서명 → 릴레이어가 USDC.transferWithAuthorization() 직접 호출
  // EIP-7702 authorization 서명 불필요 (유저는 한 번의 서명만 함)
  // 기본 xlayer 경로는 eip7702_xlayer 모드 사용
  async _payEIP3009(signer, owner, to, amountRaw, deadline, token, tokenCfg) {
    const nonce = ethers.hexlify(ethers.randomBytes(32)); // bytes32 random nonce

    // USDC 자체 도메인으로 TransferWithAuthorization 서명
    const usdcDomain = {
      name:              "USD Coin",
      version:           "2",
      chainId:           this.chainCfg.chainId,
      verifyingContract: tokenCfg.address,
    };

    const witnessSig = await signer.signTypedData(usdcDomain, Q402_EIP3009_TYPES, {
      from:        owner,
      to,
      value:       BigInt(amountRaw),
      validAfter:  0n,
      validBefore: BigInt(deadline),
      nonce,
    });

    // Relay API 호출 — eip3009Nonce 전달 (authorization 없음)
    const resp = await fetch(this.relayUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        apiKey:       this.apiKey,
        chain:        this.chain,
        token,
        from:         owner,
        to,
        amount:       amountRaw,
        deadline,
        witnessSig,
        eip3009Nonce: nonce,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? "Relay failed");
    return data;
  }

  /**
   * EIP-7702 authorization 서명 (avax/bnb/eth 전용)
   */
  async _signAuthorization(signer, { chainId, address, nonce }) {
    const domain = { name: "EIP7702Authorization", version: "1", chainId };
    const types  = {
      Authorization: [
        { name: "address", type: "address" },
        { name: "nonce",   type: "uint256" },
      ],
    };

    const sig     = await signer.signTypedData(domain, types, { address, nonce });
    const r       = sig.slice(0, 66);
    const s       = "0x" + sig.slice(66, 130);
    const v       = parseInt(sig.slice(130, 132), 16);
    const yParity = v === 27 ? 0 : 1;

    return { chainId, address, nonce, yParity, r, s };
  }
}

// Export for ESM / CommonJS / browser globals
if (typeof module !== "undefined") module.exports = { Q402Client };
if (typeof window !== "undefined") window.Q402Client = Q402Client;
