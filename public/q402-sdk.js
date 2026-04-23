/**
 * Q402 Client SDK (browser-compatible)
 * v1.4.0 — Multi-chain: EIP-7702 (avax/bnb/eth/xlayer/stable/mantle) + EIP-3009 (xlayer USDC fallback)
 *          Exact decimal→raw conversion via ethers.parseUnits (no IEEE-754 precision loss).
 *
 * The authoritative source for witness type, domain, and contract mapping is
 * contracts.manifest.json at the repo root. This SDK mirrors that manifest.
 *
 * ── Chain signing matrix (verified against deployed contract source) ───────────
 *
 *  Chain      Witness type           Domain name         verifyingContract   Decimals
 *  ─────────  ─────────────────────  ──────────────────  ─────────────────   ────────
 *  avax       TransferAuthorization  "Q402 Avalanche"    user's EOA          6
 *  bnb        TransferAuthorization  "Q402 BNB Chain"    user's EOA          18
 *  eth        TransferAuthorization  "Q402 Ethereum"     user's EOA          6
 *  xlayer     TransferAuthorization  "Q402 X Layer"      user's EOA          6
 *  stable     TransferAuthorization  "Q402 Stable"       user's EOA          18  ← USDT0 only
 *  mantle     TransferAuthorization  "Q402 Mantle"       user's EOA          6
 *
 *  All 6 deployed contracts compute _domainSeparator() with `address(this)`, which
 *  under EIP-7702 delegation equals the user's EOA — NOT the impl contract.
 *
 *  TransferAuthorization fields: owner, facilitator, token, recipient, amount, nonce, deadline
 *
 * ── EIP-3009 fallback (X Layer only) ───────────────────────────────────────────
 *  - Path:        xlayer + eip3009Nonce (no `authorization` object)
 *  - Tokens:      USDC only (X Layer USDT does not expose a compatible 9-param ABI)
 *  - Primary:     use EIP-7702 (authorization + xlayerNonce) for USDC or USDT
 *
 * ── Stable chain specifics ──────────────────────────────────────────────────────
 *  - Token:      USDT0 only (0x779ded0c9e1022225f8e0630b35a9b54be713736, mainnet)
 *  - Decimals:   18 (not 6 — parse with ethers.parseUnits(amount, 18))
 *  - Gas token:  USDT0 — the GasTank must be funded with USDT0, not a native coin
 *  - Chain ID:   988 (mainnet), 2201 (testnet)
 *  - API input:  pass token: "USDC" or "USDT" — both resolve to USDT0 on this chain.
 *                "USDT0" is NOT a valid API token key; it's the on-chain asset name.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────────
 *   const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
 *   const result = await q402.pay({ to: "0x...", amount: "5.00", token: "USDC" });
 *
 *   // Stable — pass token: "USDT" (resolves to USDT0), amount in human-readable form
 *   const q402s = new Q402Client({ apiKey: "q402_live_xxx", chain: "stable" });
 *   const result = await q402s.pay({ to: "0x...", amount: "1.00", token: "USDT" });
 */

const Q402_CHAIN_CONFIG = {
  avax: {
    name:         "Avalanche",
    chainId:      43114,
    mode:         "eip7702",
    domainName:   "Q402 Avalanche",
    implContract: "0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c",
    usdc: { address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
    usdt: { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
  },
  bnb: {
    name:         "BNB Chain",
    chainId:      56,
    mode:         "eip7702",
    domainName:   "Q402 BNB Chain",
    implContract: "0x6cF4aD62C208b6494a55a1494D497713ba013dFa",
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  },
  eth: {
    name:         "Ethereum",
    chainId:      1,
    mode:         "eip7702",
    domainName:   "Q402 Ethereum",
    implContract: "0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD",
    usdc: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    usdt: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  },
  xlayer: {
    name:         "X Layer",
    chainId:      196,
    mode:         "eip7702_xlayer",
    domainName:   "Q402 X Layer",
    implContract: "0x8D854436ab0426F5BC6Cc70865C90576AD523E73",
    usdc: { address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
    usdt: { address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41D", decimals: 6 },
  },
  stable: {
    name:         "Stable",
    chainId:      988,
    mode:         "eip7702_stable",
    domainName:   "Q402 Stable",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    // USDT0 is the only token on Stable (gas token + transfer token)
    usdc: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
    usdt: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
  },
  mantle: {
    name:         "Mantle",
    chainId:      5000,
    mode:         "eip7702",
    domainName:   "Q402 Mantle",
    implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
    usdc: { address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9", decimals: 6 },
    usdt: { address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", decimals: 6 },
  },
};

// EIP-7702 witness type — shared by all 6 chains (avax/bnb/eth/xlayer/stable/mantle).
// All Q402PaymentImplementation* contracts use the identical TransferAuthorization
// typehash. verifyingContract = address(this), which under EIP-7702 delegation = user EOA.
const Q402_TRANSFER_AUTH_TYPES = {
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

// EIP-3009 type (X Layer USDC fallback only) — matches on-chain USDC TransferWithAuthorization.
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

// Human-readable decimal string → raw token units (string form of uint256).
// Must NOT go through Number/parseFloat: IEEE-754 doubles only preserve ~15–17
// significant digits, so 18-decimal tokens (BNB USDC/USDT, Stable USDT0) lose
// precision below the dust threshold and silently round the wrong way.
function toRawAmount(amount, decimals) {
  if (typeof amount !== "string" || amount.trim() === "") {
    throw new Error('Q402: amount must be a non-empty decimal string (e.g. "5.00")');
  }
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(
      `Q402: invalid amount "${amount}" — use a positive decimal string like "5.00" (no sign, no scientific notation, no whitespace)`
    );
  }
  let raw;
  try {
    raw = ethers.parseUnits(amount, decimals);
  } catch {
    throw new Error(
      `Q402: amount "${amount}" has more than ${decimals} decimal places for this token`
    );
  }
  if (raw <= 0n) {
    throw new Error(`Q402: amount must be greater than zero (got "${amount}")`);
  }
  return raw.toString();
}

class Q402Client {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey     - Your Q402 API key (q402_live_xxx)
   * @param {"avax"|"bnb"|"eth"|"xlayer"|"stable"|"mantle"} opts.chain - Target chain
   * @param {string} [opts.relayUrl] - Override relay endpoint (default: https://q402.quackai.ai/api/relay)
   */
  constructor({ apiKey, chain = "avax", relayUrl = "https://q402.quackai.ai/api/relay" }) {
    this.apiKey   = apiKey;
    this.chain    = chain;
    this.relayUrl = relayUrl;
    this.chainCfg = Q402_CHAIN_CONFIG[chain];
    if (!this.chainCfg) throw new Error(`Unsupported chain: ${chain}. Supported: avax, bnb, eth, xlayer, stable, mantle`);
  }

  /**
   * Make a gasless token payment.
   *
   * @param {object} opts
   * @param {string} opts.to     - Recipient address (0x-prefixed, 40 hex chars)
   * @param {string} opts.amount - Human-readable decimal STRING e.g. "5.00" or "0.123456".
   *                               Must not exceed the token's decimal precision. Numbers
   *                               and scientific notation are rejected — never pass a
   *                               JS Number, since IEEE-754 loses precision for
   *                               18-decimal tokens.
   * @param {"USDC"|"USDT"} opts.token
   * @returns {Promise<{success, txHash, blockNumber, tokenAmount, token, chain, method}>}
   * @throws  When amount is empty, malformed, negative, zero, or has more
   *          decimal places than the target token supports.
   */
  async pay({ to, amount, token = "USDC" }) {
    const ethereum = window.ethereum || window.okxwallet;
    if (!ethereum) throw new Error("No Web3 wallet found. Install MetaMask or OKX Wallet.");

    const provider = new ethers.BrowserProvider(ethereum);
    const signer   = await provider.getSigner();
    const owner    = await signer.getAddress();

    const tokenCfg = this.chainCfg[token.toLowerCase()];
    if (!tokenCfg) throw new Error(`Unsupported token: ${token} on chain ${this.chain}`);

    const decimals  = tokenCfg.decimals;
    const amountRaw = toRawAmount(amount, decimals);
    const deadline  = Math.floor(Date.now() / 1000) + 600; // +10min

    if (this.chainCfg.mode === "eip7702_xlayer") {
      return this._payXLayerEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg);
    } else if (this.chainCfg.mode === "eip7702_stable") {
      return this._payStableEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg);
    } else if (this.chainCfg.mode === "eip3009") {
      return this._payEIP3009(signer, owner, to, amountRaw, deadline, token, tokenCfg);
    } else {
      return this._payEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg);
    }
  }

  // ── EIP-7702 결제 (avax / bnb / eth / mantle) ────────────────────────────────
  // Q402PaymentImplementation.transferWithAuthorization() 사용
  // witness type: TransferAuthorization
  // domain name: per-chain (contract NAME 상수와 일치)
  // verifyingContract: user's EOA (address(this) under EIP-7702 delegation)
  async _payEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg) {
    // 1. Fetch facilitator (relayer wallet) — must match on-chain msg.sender
    const infoUrl  = this.relayUrl.replace(/\/relay$/, "/relay/info");
    const infoResp = await fetch(infoUrl);
    if (!infoResp.ok) throw new Error("Failed to fetch relay facilitator info");
    const { facilitator } = await infoResp.json();

    // 2. EIP-712 TransferAuthorization signature
    const domain = {
      name:              this.chainCfg.domainName,
      version:           "1",
      chainId:           this.chainCfg.chainId,
      verifyingContract: owner,
    };

    const paymentNonce = ethers.toBigInt(ethers.randomBytes(32));

    const witnessSig = await signer.signTypedData(domain, Q402_TRANSFER_AUTH_TYPES, {
      owner,
      facilitator,
      token:     tokenCfg.address,
      recipient: to,
      amount:    BigInt(amountRaw),
      nonce:     paymentNonce,
      deadline:  BigInt(deadline),
    });

    // 3. EIP-7702 authorization signature
    const authNonce     = await provider.getTransactionCount(owner);
    const authorization = await this._signAuthorization(signer, {
      chainId: this.chainCfg.chainId,
      address: this.chainCfg.implContract,
      nonce:   authNonce,
    });

    // 4. Relay API call
    const resp = await fetch(this.relayUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        apiKey:  this.apiKey,
        chain:   this.chain,
        token,
        from:    owner,
        to,
        amount:  amountRaw,
        deadline,
        nonce:   paymentNonce.toString(),
        witnessSig,
        authorization,
        facilitator,
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
      name:              this.chainCfg.domainName,
      version:           "1",
      chainId:           this.chainCfg.chainId,
      verifyingContract: owner,  // ← user's own EOA, NOT impl contract
    };

    // random uint256 nonce (replay protection via usedNonces mapping in contract)
    const nonceBuf    = ethers.randomBytes(32);
    const xlayerNonce = ethers.toBigInt(nonceBuf);

    const witnessSig = await signer.signTypedData(domain, Q402_TRANSFER_AUTH_TYPES, {
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

  // ── EIP-7702 Stable 결제 ──────────────────────────────────────────────────────
  // Q402PaymentImplementationStable.transferWithAuthorization() 사용
  // witness type: TransferAuthorization
  // domain name: "Q402 Stable" (contract NAME 일치)
  // verifyingContract: user's EOA (address(this) under EIP-7702 delegation)
  // gas token: USDT0 (18 decimals)
  async _payStableEIP7702(signer, provider, owner, to, amountRaw, deadline, token, tokenCfg) {
    // 1. Relay 서버에서 facilitator 주소 조회
    const infoUrl = this.relayUrl.replace(/\/relay$/, "/relay/info");
    const infoResp = await fetch(infoUrl);
    if (!infoResp.ok) throw new Error("Failed to fetch relay facilitator info");
    const { facilitator } = await infoResp.json();

    // 2. EIP-712 TransferAuthorization 서명
    //    verifyingContract = owner's EOA (address(this) under EIP-7702 delegation)
    const domain = {
      name:              this.chainCfg.domainName,
      version:           "1",
      chainId:           this.chainCfg.chainId,
      verifyingContract: owner,
    };

    const nonceBuf    = ethers.randomBytes(32);
    const stableNonce = ethers.toBigInt(nonceBuf);

    const witnessSig = await signer.signTypedData(domain, Q402_TRANSFER_AUTH_TYPES, {
      owner,
      facilitator,
      token:     tokenCfg.address,
      recipient: to,
      amount:    BigInt(amountRaw),
      nonce:     stableNonce,
      deadline:  BigInt(deadline),
    });

    // 3. EIP-7702 authorization 서명
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
        apiKey:        this.apiKey,
        chain:         this.chain,
        token,
        from:          owner,
        to,
        amount:        amountRaw,
        deadline,
        witnessSig,
        authorization,
        stableNonce:   stableNonce.toString(),
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
   * EIP-7702 authorization 서명 (avax/bnb/eth/xlayer/stable/mantle 공통)
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
if (typeof module !== "undefined") module.exports = { Q402Client, toRawAmount };
if (typeof window !== "undefined") {
  window.Q402Client = Q402Client;
  window.Q402Client.toRawAmount = toRawAmount;
}
