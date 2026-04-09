# Q402 — Gasless Payment Infrastructure

> Multi-chain ERC-20 gasless payment relay for DeFi applications and AI agents.  
> Users pay USDC/USDT with zero gas — Q402 relayer covers all transaction fees.

**Version: v1.6** · **Last updated: 2026-04-09**  
**GitHub:** https://github.com/bitgett/Q402-Institutional  
**Live:** https://q402-institutional.vercel.app  
**Contact:** hello@quackai.ai

---

## 목차

1. [Why We Built This](#1-why-we-built-this)
2. [What is Q402](#2-what-is-q402)
3. [Supported Chains](#3-supported-chains)
4. [Tech Stack](#4-tech-stack)
5. [Quick Start (로컬 개발)](#5-quick-start)
6. [Pages & Project Structure](#6-pages--project-structure)
7. [Payment Flow](#7-payment-flow)
8. [SDK Usage](#8-sdk-usage)
9. [API Reference](#9-api-reference)
10. [Authentication Model](#10-authentication-model)
11. [Subscription Plans & Rate Limits](#11-subscription-plans--rate-limits)
12. [KV 데이터 모델](#12-kv-데이터-모델)
13. [Relay 내부 동작 (EIP-7702 / EIP-3009)](#13-relay-내부-동작)
14. [Webhook System](#14-webhook-system)
15. [Sandbox Mode](#15-sandbox-mode)
16. [Gas Tank](#16-gas-tank)
17. [v1.6 신규 기능](#17-v16-신규-기능)
18. [Stable Chain 통합](#18-stable-chain-통합)
19. [컨트랙트 & 토큰 주소](#19-컨트랙트--토큰-주소)
20. [보안 (v1.2 감사 + 속성)](#20-보안)
21. [Vercel 배포](#21-vercel-배포)
22. [릴레이어 지갑](#22-릴레이어-지갑)
23. [테스트 스크립트 & Agent SDK](#23-테스트-스크립트--agent-sdk)
24. [남은 작업 / 로드맵](#24-남은-작업--로드맵)
25. [Changelog](#25-changelog)

---

## 1. Why We Built This

모든 EVM 블록체인은 사용자가 USDC/USDT를 이동하려면 네이티브 가스 토큰(BNB, ETH, AVAX, OKB, USDT0)을 보유해야 한다.

> BNB Chain에서 USDC 100달러를 가진 유저는 **BNB 없이는 아무것도 전송할 수 없다.**  
> Web3 온보딩은 이 단계에서 무너진다.

**Q402가 존재하는 4가지 이유:**

1. **Web3 대중화는 가스 UX가 막고 있다.** Stripe, PayPal, Venmo는 수수료를 사용자에게 전가하지 않는다. Web3도 이 기준에 도달해야 한다.

2. **AI Agent는 가스리스 결제 레일이 필요하다.** 100개 에이전트가 5개 체인에서 가스를 각자 관리하는 것은 운영 악몽이다. Gas Tank 한 번 충전으로 전체를 처리한다.

3. **EIP-7702가 올바른 프리미티브다.** ERC-4337(Account Abstraction)과 달리 기존 EOA 그대로 동작 — 지갑 마이그레이션 불필요. MetaMask, OKX Wallet이 즉시 참여 가능.

4. **멀티체인 Day 1.** 대부분의 가스리스 솔루션은 체인 1개. Q402는 5개 메인넷에 동시 배포.

---

## 2. What is Q402

Q402는 **EIP-7702 + EIP-712 기반 가스리스 결제 인프라**다. 개발자가 SDK를 통합하면 Q402 릴레이어가 모든 온체인 가스를 대납한다.

**avax / bnb / eth / stable — EIP-7702 플로우:**
```
User clicks "Pay USDC"
  → SDK: EIP-712 witnessSig + EIP-7702 authorization 서명 (2 sigs)
    → POST /api/relay { witnessSig, authorization }
      → Q402 relayer: Type 4 TX 제출 (가스 대납)
        → Q402PaymentImplementation.pay() 실행
          → USDC: user EOA → recipient
```

**xlayer — EIP-7702 플로우** (2026-03-12 확인):
```
User clicks "Pay USDC"
  → SDK: GET /api/relay/info (facilitator 주소 조회)
    → EIP-712 TransferAuthorization + EIP-7702 authorization (2 sigs)
      → POST /api/relay { witnessSig, authorization, xlayerNonce }
        → Q402 relayer: Type 4 TX 제출 (OKB 가스 대납)
          → Q402PaymentImplementationXLayer.transferWithAuthorization()
            → USDC: user EOA → recipient
```

> X Layer는 EIP-3009 fallback도 지원 — `eip3009Nonce` 전달 시 자동 선택.

---

## 3. Supported Chains

| Chain | ChainID | 릴레이 방식 | 컨트랙트 | 상태 |
|-------|---------|-----------|---------|------|
| Avalanche C-Chain | 43114 | EIP-7702 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | ✅ |
| BNB Chain | 56 | EIP-7702 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | ✅ |
| Ethereum | 1 | EIP-7702 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | ✅ |
| X Layer | 196 | EIP-7702 + EIP-3009 fallback | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | ✅ |
| **Stable** | **988** | **EIP-7702** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | ✅ |

> Stable 특이사항: USDT0가 가스 토큰이자 결제 토큰 (네이티브 코인 = USD 페그).

---

## 4. Tech Stack

| 항목 | 기술 |
|------|------|
| Framework | Next.js 14 App Router (TypeScript) |
| Styling | Tailwind CSS + framer-motion |
| Blockchain | ethers.js v6 + viem |
| Wallet | Custom WalletContext (MetaMask + OKX Wallet) |
| Database | Vercel KV (Redis) |
| Deployment | Vercel (git push → 자동 배포) |
| Contract | Solidity 0.8.20, EIP-7702, EIP-712 |

---

## 5. Quick Start

### 클론 & 설치

```bash
git clone https://github.com/bitgett/Q402-Institutional.git
cd Q402-Institutional
npm install
```

### 환경변수 설정 (`.env.local`)

```env
# 릴레이어 지갑 Private Key — 절대 외부 노출 금지
RELAYER_PRIVATE_KEY=0x...   # q402-avalanche/.env의 DEPLOYER_PRIVATE_KEY

# 컨트랙트 주소 (v1.3)
IMPLEMENTATION_CONTRACT=0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c
BNB_IMPLEMENTATION_CONTRACT=0x6cF4aD62C208b6494a55a1494D497713ba013dFa
ETH_IMPLEMENTATION_CONTRACT=0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD
XLAYER_IMPLEMENTATION_CONTRACT=0x8D854436ab0426F5BC6Cc70865C90576AD523E73
STABLE_IMPLEMENTATION_CONTRACT=0x2fb2B2D110b6c5664e701666B3741240242bf350

# Vercel KV — Vercel 대시보드 → Storage → Q402 KV에서 복사
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...

# Admin 엔드포인트 보호
ADMIN_SECRET=your_admin_secret_here

# 선택사항: Telegram 문의 알림
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# 선택사항: 테스트용
TEST_PAYER_KEY=0x...
ETH_RPC_URL=https://eth.llamarpc.com
```

### 개발 서버 실행

```bash
npm run dev
# → http://localhost:3000 (포트 점유 시 3001~3004 자동 증가)
```

### 컨트랙트 배포 (새 체인 추가 시)

```bash
cd q402-avalanche/q402-avalanche
npm install
npx hardhat run scripts/deploy.ts --network avalanche
npx hardhat run scripts/deploy-bnb.ts --network bnb
npx hardhat run scripts/deploy-eth.ts --network eth
npx hardhat run scripts/deploy-xlayer.ts --network xlayer
npx hardhat run scripts/deploy-stable.ts --network stable
```

---

## 6. Pages & Project Structure

### 페이지 목록

| Route | 설명 |
|-------|------|
| `/` | 랜딩 — Hero, HowItWorks, Pricing, Contact |
| `/agents` | AI Agent 플랜 — SVG 네트워크 애니메이션, 실시간 TX 피드, Contact 모달 |
| `/payment` | 4단계 온체인 결제 → API Key 자동 발급 |
| `/dashboard` | 개발자 대시보드 (API Key, Gas Tank, Transactions, Webhook) |
| `/docs` | API Reference & Integration Guide |

### 디렉터리 구조

```
Q402-Institutional/
├── app/
│   ├── api/
│   │   ├── payment/
│   │   │   ├── activate/route.ts   # POST — 온체인 결제 스캔 + API Key 발급
│   │   │   └── check/route.ts      # POST — 구독 상태 확인
│   │   ├── keys/
│   │   │   ├── provision/route.ts  # POST — 구독 수동 생성 (Admin)
│   │   │   ├── generate/route.ts   # POST — API Key 재발급 (Admin)
│   │   │   ├── verify/route.ts     # POST — API Key 유효성 검증
│   │   │   ├── topup/route.ts      # POST — 할당량 보너스 추가 (Admin)
│   │   │   └── rotate/route.ts     # POST — API Key 교체 (EIP-191 인증)
│   │   ├── gas-tank/
│   │   │   ├── route.ts            # GET  — 릴레이어 온체인 잔고
│   │   │   ├── verify-deposit/route.ts # POST — 유저 입금 스캔
│   │   │   ├── user-balance/route.ts   # GET  — 유저 입금 잔고 조회
│   │   │   └── withdraw/route.ts   # POST — 가스 잔고 출금 (Admin)
│   │   ├── relay/
│   │   │   ├── route.ts            # POST — EIP-7702 / EIP-3009 릴레이
│   │   │   └── info/route.ts       # GET  — facilitator 주소 (SDK용)
│   │   ├── webhook/
│   │   │   ├── route.ts            # POST/GET/DELETE — Webhook 관리
│   │   │   └── test/route.ts       # POST — 테스트 이벤트 발송
│   │   ├── transactions/route.ts   # GET  — 릴레이 TX 이력
│   │   ├── wallet-balance/route.ts # GET  — 유저 지갑 잔고 (5체인)
│   │   └── inquiry/route.ts        # POST/GET — 프로젝트 문의
│   ├── lib/
│   │   ├── db.ts                   # Vercel KV CRUD 헬퍼 (월별 TX 샤딩)
│   │   ├── blockchain.ts           # ERC-20 Transfer 이벤트 스캔
│   │   ├── relayer.ts              # viem EIP-7702 settle 함수들
│   │   ├── access.ts               # MASTER_ADDRESSES / isPaid()
│   │   ├── ratelimit.ts            # KV sliding-window rate limiter
│   │   └── wallet.ts               # MetaMask / OKX connectWallet
│   ├── context/WalletContext.tsx   # 전역 지갑 상태 (localStorage 즉시 복원)
│   ├── components/
│   │   ├── Hero.tsx                # 랜딩 히어로 + 터미널 애니메이션
│   │   ├── HowItWorks.tsx          # 3단계 설명 + 체인 로고 5개
│   │   ├── Pricing.tsx             # 4단계 요금제
│   │   ├── Contact.tsx             # CTA — "Talk to Us" popup
│   │   ├── Navbar.tsx              # 네비게이션 + Agents 링크
│   │   ├── Footer.tsx              # 5+ 체인, Stable 배지
│   │   ├── WalletButton.tsx        # MetaMask + OKX 지갑 모달
│   │   └── RegisterModal.tsx       # 프로젝트 문의 팝업
│   ├── agents/page.tsx             # AI Agent 플랜 페이지
│   ├── dashboard/page.tsx          # 대시보드 (4개 탭)
│   ├── payment/page.tsx            # 온체인 결제 Builder
│   ├── docs/page.tsx               # API Reference
│   └── page.tsx                    # 랜딩 메인
├── scripts/
│   ├── test-bnb-eip7702.mjs        # BNB EIP-7702 E2E 테스트
│   ├── test-eth-eip7702.mjs        # ETH EIP-7702 E2E 테스트
│   └── agent-example.mjs           # Node.js Agent SDK (5체인 예제)
└── public/
    ├── q402-sdk.js                 # 클라이언트 SDK v1.3.0
    ├── bnb.png / eth.png / avax.png / xlayer.png / stable.jpg
    └── arbitrum.png / scroll.png
```

---

## 7. Payment Flow

`/payment` 페이지는 셀프서브 온체인 결제 → API Key 자동 발급 플로우:

1. **체인 선택** — 어떤 체인에서 릴레이할 것인가?
2. **볼륨 선택** — 월간 예상 트랜잭션 수
3. **지갑 연결** — MetaMask or OKX Wallet
4. **송금 + 검증** — Q402 주소(`0xfc77...`)로 USDC/USDT 전송 후 "Verify" 클릭 → API Key 자동 발급

결제 수단: **BNB USDC, BNB USDT, ETH USDC, ETH USDT** (구독 결제는 BNB/ETH 체인만, 의도적)  
결제 주소: `0xfc77ff29178b7286a8ba703d7a70895ca74ff466`

---

## 8. SDK Usage

### 브라우저

```html
<script src="https://q402.xyz/q402-sdk.js"></script>
<script src="https://cdn.ethers.io/lib/ethers-5.7.2.umd.min.js"></script>
```

```javascript
// AVAX / BNB / ETH / Stable — EIP-7702
const q402 = new Q402Client({ apiKey: "q402_live_xxx", chain: "avax" });
const result = await q402.pay({ to: "0xRecipient", amount: "5.00", token: "USDC" });
console.log(result.txHash); // method: "eip7702"

// X Layer — EIP-7702 (facilitator 자동 조회)
const q402xl = new Q402Client({ apiKey: "q402_live_xxx", chain: "xlayer" });
const result2 = await q402xl.pay({ to: "0xRecipient", amount: "1.00", token: "USDC" });
console.log(result2.txHash); // method: "eip7702_xlayer"

// Stable (USDT0, 18 decimals)
const q402s = new Q402Client({ apiKey: "q402_live_xxx", chain: "stable" });
const result3 = await q402s.pay({ to: "0xRecipient", amount: "10.00", token: "USDT0" });
```

SDK: **v1.3.0** — 5개 체인 지원 (avax, bnb, eth, xlayer, stable)

### Node.js Agent

`scripts/agent-example.mjs`를 모듈로 import:

```javascript
import { sendGaslessPayment } from "./scripts/agent-example.mjs";

const result = await sendGaslessPayment({
  chain:      "avax",   // "avax" | "bnb" | "eth" | "xlayer" | "stable"
  recipient:  "0x...",
  amountUSD:  10.0,
});
console.log(result.txHash);
```

### SDK 내부 동작

**EIP-7702 체인 (avax / bnb / eth / stable)**
```
q402.pay() 호출
  ├─ 1. EIP-712 witnessSig 서명
  │      domain: { name, version, chainId, verifyingContract: implContract }
  │      types:  TransferAuthorization { owner, facilitator, token, recipient, amount, nonce, deadline }
  ├─ 2. EIP-7702 authorization 서명
  │      { address: implContract, nonce: EOA_nonce }
  └─ 3. POST /api/relay { witnessSig, authorization }
```

**EIP-7702 XLayer**
```
q402xl.pay() 호출
  ├─ 0. GET /api/relay/info → facilitator 주소
  ├─ 1. TransferAuthorization EIP-712 서명
  │      verifyingContract = 유저 EOA (avax/bnb/eth와 핵심 차이)
  ├─ 2. EIP-7702 authorization { address: xlayerImpl }
  └─ 3. POST /api/relay { witnessSig, authorization, xlayerNonce }
```

---

## 9. API Reference

### POST /api/relay

EIP-712 + EIP-7702 페이로드 제출 → 가스리스 릴레이.  
`apiKey` 필수, 구독 만료 및 키 교체 검증.

**avax / bnb / eth / stable 요청:**
```json
{
  "apiKey":        "q402_live_xxx",
  "chain":         "avax",
  "token":         "0xB97EF9Ef8734...",
  "from":          "0xPayerEOA",
  "to":            "0xRecipient",
  "amount":        "5000000",
  "deadline":      1712345678,
  "nonce":         "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 43114, "address": "0x96a8...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**xlayer EIP-7702 추가 필드:** `xlayerNonce` (uint256 string)  
**xlayer EIP-3009 fallback:** `authorization` 대신 `eip3009Nonce` (bytes32 hex)

**응답:**
```json
{
  "success":      true,
  "txHash":       "0x...",
  "blockNumber":  "54540550",
  "tokenAmount":  5.0,
  "token":        "USDC",
  "chain":        "avax",
  "gasCostNative": 0.00042,
  "method":       "eip7702"
}
```
> method 값: `"eip7702"` / `"eip7702_xlayer"` / `"eip3009"`

### GET /api/relay/info

릴레이어(facilitator) 지갑 주소 반환. XLayer EIP-7702 서명에 필요.
```json
{ "facilitator": "0xfc77ff29178b7286a8ba703d7a70895ca74ff466" }
```

### POST /api/payment/activate

블록체인에서 USDC/USDT 결제 스캔 → 구독 활성화 + API Key 자동 발급.  
EIP-191 서명(소유권 증명) 필요.

```json
// 요청
{ "address": "0x...", "signature": "0x..." }
// 응답
{ "status": "activated", "plan": "growth" }
```

### POST /api/payment/check

구독 상태 확인.

### POST /api/inquiry

프로젝트 문의 제출 → Vercel KV 저장 + Telegram 알림.

```json
{
  "appName": "MyDApp", "website": "https://...", "email": "dev@...",
  "telegram": "@handle", "category": "DeFi", "targetChain": "avax",
  "expectedVolume": "1000-5000", "description": "..."
}
```

### POST /api/keys/verify

API Key 유효성 검증 + 만료/교체 확인.
```json
{ "valid": true, "address": "0x...", "plan": "growth", "expired": false, "expiresAt": "..." }
```

### POST /api/keys/rotate

현재 라이브 키 폐기 + 새 키 발급. EIP-191 서명 필요.

### Admin 전용 (헤더: `x-admin-secret`)

| Endpoint | Method | 설명 |
|----------|--------|------|
| `/api/keys/provision` | POST | 구독 수동 생성 + API Key 발급 |
| `/api/keys/generate` | POST | API Key 재발급 |
| `/api/keys/topup` | POST | 할당량 보너스 추가 |
| `/api/gas-tank/withdraw` | POST | 가스 잔고 출금 |
| `/api/inquiry` | GET | 문의 목록 조회 |

---

## 10. Authentication Model

**EIP-191 personal_sign** — 모든 유저용 API에서 지갑 소유권 증명:

```
서명 메시지: "Q402 API Key Request\nAddress: {address_lowercase}"
```

1. 클라이언트가 한 번 서명 → `sessionStorage["q402_sig_0xaddr"]`에 캐시
2. 서버: `ethers.verifyMessage(msg, sig)` → 주소 일치 확인

`/api/keys/provision`, `/api/keys/rotate`, `/api/transactions`, `/api/payment/activate`에 적용.

---

## 11. Subscription Plans & Rate Limits

### 플랜별 월간 할당량

| Plan | TX/월 | 일일 버스트 한도 | 비고 |
|------|-------|----------------|------|
| Starter | 500 | 50/day | |
| Basic | 1,000 | 100/day | |
| Growth | 10,000 | 1,000/day | |
| Pro | 10,000 | 1,000/day | |
| Scale | 100,000 | 10,000/day | |
| Business | 100,000 | 10,000/day | |
| Enterprise | 500,000 | 무제한 | 커스텀 SLA |
| Enterprise Flex | 500,000+ | 무제한 | |
| **Agent** | **무제한** | **무제한** | Gas Tank 선불, `/agents` 참조 |

일일 한도 초과 시: `HTTP 429 Daily relay cap reached for plan {plan}` (86400s window)  
Sandbox 키(`q402_test_`)는 한도 적용 안 함.

### API Rate Limits (IP당)

| Endpoint | 한도 |
|----------|------|
| /api/relay | 60 req/60s |
| /api/keys/provision | 10 req/60s |
| /api/keys/rotate | 5 req/60s |
| /api/payment/activate | 5 req/60s |
| /api/payment/check | 30 req/60s |
| /api/transactions | 30 req/60s |
| /api/webhook | 10 req/60s |
| /api/inquiry | 3 req/600s |

---

## 12. KV 데이터 모델

**Vercel KV (Redis)** — `app/lib/db.ts`

### 키 스키마

```
kv.get("sub:{address}")                  → Subscription
kv.get("apikey:{apiKey}")                → ApiKeyRecord
kv.get("gasdep:{address}")               → GasDeposit[]
kv.get("relaytx:{address}:{YYYY-MM}")    → RelayedTx[]   ← 월별 분산 (v1.6)
kv.get("gasused:{address}")              → Record<chain, number>  ← 누적 합계 (v1.6)
kv.get("webhook:{address}")              → WebhookConfig
kv.get("inquiries")                      → Inquiry[]
```

**KV 용량 전략 (v1.6):**
- TX 이력: 월별 키 `relaytx:{addr}:{YYYY-MM}` — 월 10,000건 상한 (초과 시 중단, 릴레이 지속)
- 가스 소비: `gasused:{addr}` 별도 누적 — TX 배열 전체 스캔 불필요
- 할당량 체크: `getThisMonthTxCount()` → 현재 월 키 단일 read (O(1))
- 잔고 계산: `getGasBalance()` → 입금배열 + 누적합계 2 read만 필요

### 데이터 구조

**Subscription**
```json
{
  "paidAt":      "2026-04-09T00:00:00.000Z",
  "apiKey":      "q402_live_xxx",
  "sandboxApiKey": "q402_test_xxx",
  "plan":        "growth",
  "txHash":      "0xOnChainPaymentTxHash",
  "amountUSD":   150,
  "quotaBonus":  0
}
```

**ApiKeyRecord**
```json
{
  "address":   "0xOwnerAddress",
  "createdAt": "2026-04-09T00:00:00.000Z",
  "active":    true,
  "plan":      "growth",
  "isSandbox": false
}
```

**RelayedTx**
```json
{
  "apiKey":        "q402_live_xxx",
  "address":       "0xOwner",
  "chain":         "avax",
  "fromUser":      "0xPayer",
  "toUser":        "0xRecipient",
  "tokenAmount":   5.0,
  "tokenSymbol":   "USDC",
  "gasCostNative": 0.00042,
  "relayTxHash":   "0x...",
  "relayedAt":     "2026-04-09T12:00:00.000Z"
}
```

### DB 헬퍼 함수

| 함수 | 역할 |
|------|------|
| `getSubscription(address)` | 구독 조회 |
| `setSubscription(address, data)` | 구독 저장/갱신 |
| `getApiKeyRecord(apiKey)` | API Key → 레코드 |
| `generateApiKey(address, plan)` | 새 라이브 키 생성 |
| `generateSandboxKey(address, plan)` | 새 샌드박스 키 생성 |
| `deactivateApiKey(apiKey)` | 키 비활성화 |
| `rotateApiKey(address)` | 기존 키 폐기 + 새 키 발급 + sub 업데이트 |
| `getGasDeposits(address)` | 입금 내역 목록 |
| `addGasDeposit(address, deposit)` | 입금 추가 (txHash 중복 방지) |
| `getGasBalance(address)` | 입금합계 − 소비합계 = 현재 잔고 |
| `getRelayedTxs(address, months?)` | TX 이력 (기본: 현재+이전 월) |
| `getThisMonthTxCount(address)` | 이번 달 TX 수 (O(1) 할당량 체크) |
| `getGasUsedTotals(address)` | 체인별 누적 가스 소비 합계 |
| `recordRelayedTx(address, tx)` | TX 기록 (월별 배열 + 누적합계 동시 갱신) |
| `getWebhookConfig(address)` | Webhook 설정 조회 |
| `setWebhookConfig(address, config)` | Webhook 저장 |
| `addQuotaBonus(address, n)` | 할당량 보너스 추가 |
| `isSubscriptionActive(address)` | 구독 유효 여부 |
| `getPlanQuota(plan)` | 플랜별 월간 할당량 |

---

## 13. Relay 내부 동작

### 13-A. EIP-7702 (avax / bnb / eth / stable)

```
유저 EOA ──(EIP-7702 authorization)──▶ Q402PaymentImplementation
                                         .pay() 실행 시 유저 EOA처럼 동작
```

**EIP-712 서명 도메인:**
```javascript
{
  name:              "Q402 Avalanche",  // 체인별 다름
  version:           "1",
  chainId:           43114,
  verifyingContract: "0x96a8..."        // impl contract
}

// types
TransferAuthorization: [
  { name: "owner",       type: "address" },
  { name: "facilitator", type: "address" },
  { name: "token",       type: "address" },
  { name: "recipient",   type: "address" },
  { name: "amount",      type: "uint256" },
  { name: "nonce",       type: "uint256" },
  { name: "deadline",    type: "uint256" },
]
```

**viem Type 4 TX 전송 (`app/lib/relayer.ts`):**
```typescript
const txHash = await walletClient.sendTransaction({
  chain: null,
  to:   params.owner,     // 유저 EOA
  data: callData,         // Q402PaymentImplementation.pay() calldata
  gas:  BigInt(300000),
  authorizationList: [{ ...params.authorization }],
});
```

**가스 비용 계산:**
```typescript
const gasCostNative = parseFloat(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));
```

### 13-B. EIP-7702 (xlayer) — avax/bnb/eth와의 차이

| 항목 | avax / bnb / eth / stable | xlayer |
|------|--------------------------|--------|
| 컨트랙트 | `Q402PaymentImplementation` | `Q402PaymentImplementationXLayer` |
| 함수 | `pay()` | `transferWithAuthorization()` |
| `verifyingContract` | implContract | **유저 EOA** (`address(this)` under delegation) |
| nonce 타입 | `uint256` (random) | `uint256` (random, usedNonces mapping) |
| facilitator 체크 | 없음 | `msg.sender == facilitator` 필수 |

```javascript
// XLayer — verifyingContract = owner (EOA)
const domain = {
  name:              "Q402 X Layer",
  version:           "1",
  chainId:           196,
  verifyingContract: owner,  // ← 유저 EOA
};
```

> SDK가 서명 전 `GET /api/relay/info`로 facilitator 주소 자동 조회.

**검증된 XLayer EIP-7702 테스트 결과 (2026-03-12):**

| 항목 | 값 |
|------|---|
| TX Hash | `0xd121c23c6313e2f73751b3735f5a9c934386930ef1ca0ba04578de1bfddfd9a0` |
| Block | 54540550 |
| Payer OKB | 0 OKB ✅ |
| USDC 이동 | 0.05 USDC ✅ |

### 13-C. EIP-3009 (xlayer fallback)

`eip3009Nonce`(bytes32) 전달 시 자동 선택. SDK v1.1.x 이하 하위호환.

```json
{
  "chain": "xlayer",
  "witnessSig": "0x...",
  "eip3009Nonce": "0xrandomBytes32..."
}
```

**검증된 EIP-3009 테스트 결과 (2026-03-12):**
- TX: `0xb21a10be318e7893d9246ae49a141c18152040b1ceb68eb3e799b62c953fbc3c`
- Block: 54523313 / USDC 이동: 0.05 ✅

### 13-D. 처리 단계 (공통)

1. API Key 검증 (`getApiKeyRecord`, `active` 확인)
2. 구독 만료 + 키 교체 확인 (30일 만료, `sub.apiKey !== apiKey` → 401)
3. **일일 버스트 한도** 확인 (플랜별 KV sliding window 86400s) — v1.6
4. 월간 할당량 확인 (`getThisMonthTxCount`) — v1.6
5. Gas Tank 잔고 확인 (`getGasBalance[chain] > 0.0001`)
6. 체인 분기:
   - xlayer + `authorization+xlayerNonce` → `settlePaymentXLayerEIP7702()`
   - xlayer + `eip3009Nonce` → `settlePaymentEIP3009()`
   - 기타 → `settlePayment()`
7. TX 기록 (`recordRelayedTx` — 월별 배열 + 누적합계)
8. Webhook 발송 (등록된 경우)

---

## 14. Webhook System

성공적인 릴레이 TX마다 등록된 엔드포인트로 HMAC-SHA256 서명된 이벤트 전송.

### 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/webhook` | URL 등록 (최초에만 secret 반환) |
| GET | `/api/webhook?address=0x&sig=0x` | 현재 설정 조회 (secret 미포함) |
| DELETE | `/api/webhook` | 설정 삭제 |
| POST | `/api/webhook/test` | 테스트 이벤트 발송 |

### 페이로드

```json
{
  "event":        "relay.success",
  "sandbox":      false,
  "txHash":       "0x...",
  "chain":        "avax",
  "from":         "0xUSER",
  "to":           "0xRECIPIENT",
  "amount":       5.0,
  "token":        "USDC",
  "gasCostNative": 0.00042,
  "timestamp":    "2026-04-09T12:00:00.000Z"
}
```

### 서명 검증 (Node.js)

```javascript
const hmac = crypto.createHmac('sha256', process.env.Q402_WEBHOOK_SECRET);
hmac.update(rawBody);
const valid = 'sha256=' + hmac.digest('hex') === req.headers['x-q402-signature'];
```

### SSRF 방어

등록/테스트/발송 시 private IP 차단:
```
/^(localhost|127\.|0\.0\.0\.0|::1$|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/
```

---

## 15. Sandbox Mode

`q402_test_` 접두사 API Key → 온체인 TX 없이 mock 응답 반환.

```javascript
const q402 = new Q402Client({ apiKey: "q402_test_xxx", chain: "avax" });
const result = await q402.pay({ to: "0x...", amount: "5.00", token: "USDC" });
// result.success = true, result.txHash = random mock hash
// 가스 소비 없음, 온체인 TX 없음
```

- `/api/keys/provision` 호출 시 live key와 함께 sandbox key 자동 발급
- Relay에서 `isSandbox` 감지: 400ms 지연 후 mock 반환
- DB에 `sandbox: true` 플래그 포함 저장
- Sandbox 키는 일일 한도 적용 안 함

---

## 16. Gas Tank

### 릴레이어 전체 잔고 (플랫폼 공유)

`GET /api/gas-tank` — 릴레이어 지갑의 온체인 잔고 실시간 조회.

```json
{
  "tanks": [
    { "key": "bnb",   "chain": "BNB Chain", "token": "BNB",  "balance": "1.2340", "usd": "$865.31" },
    { "key": "eth",   "chain": "Ethereum",  "token": "ETH",  "balance": "0.1200", "usd": "$456.00" },
    { "key": "avax",  "chain": "Avalanche", "token": "AVAX", "balance": "25.4000","usd": "$812.80" },
    { "key": "xlayer","chain": "X Layer",   "token": "OKB",  "balance": "0.0000", "usd": "$0.00"   }
  ]
}
```

### 유저 입금 잔고 (클라이언트별)

유저가 릴레이어 주소로 native token을 입금 → 릴레이 비용으로 차감.

**입금 스캔:** `POST /api/gas-tank/verify-deposit` — `{ address }`
- 4개 체인에서 배치 RPC 블록 스캔 (BNB/AVAX/XLayer: 200블록, ETH: 50블록)
- `from=유저, to=릴레이어, value≠0` 필터 → `addGasDeposit()`

**잔고 조회:** `GET /api/gas-tank/user-balance?apiKey=q402_live_xxx`

```json
{
  "balances": { "bnb": 0.5, "eth": 0.0, "avax": 2.1, "xlayer": 0.0, "stable": 0.0 },
  "deposits": [...]
}
```

**잔고 계산:**
```
getGasBalance(address) = Σ(deposits.amount) − Σ(gasused running total)
```

> v1.6: `gasused:{addr}` 별도 누적 키로 배열 스캔 없이 O(1) 계산.

**Stable 체인 특이사항:** USDT0가 가스 토큰이자 결제 토큰. Gas Tank도 USDT0로 충전 (네이티브 코인 없음).

---

## 17. v1.6 신규 기능

### A. KV TX 이력 월별 분산 저장

**문제:** `relayedtxs:{address}` 단일 배열 → 고트래픽 고객 수천 건 후 KV 1MB 초과 write 실패.

**해결:**
- `relaytx:{addr}:{YYYY-MM}` — 월마다 새 키
- 월 10,000건 상한 (초과 시 기록 중단, 릴레이 동작 지속)
- `gasused:{addr}` 별도 누적 키 → O(1) 가스 잔고 계산

### B. 구독 갱신 시 API Key 보존

**문제:** 갱신 시 항상 새 Key 발급 → 기존 통합 즉시 깨짐.

**해결:**
- 갱신 시 기존 키 유지 (`active=false`인 경우에만 새 키 발급)
- 만료일: 현재 만료일 기준 +30일 연장 (기간 중 갱신 시 누적)

```typescript
// 만료 전 갱신 → 현재 만료일 + 30일
const currentExpiry = new Date(new Date(existing.paidAt).getTime() + 30*24*60*60*1000);
const base = currentExpiry > new Date() ? currentExpiry : new Date();
newPaidAt = base.toISOString();
```

### C. 플랜별 일일 릴레이 버스트 한도

**문제:** Starter 키로 하루 수만 건 트랜잭션 → 공유 릴레이어 독점 가능.

**해결:** KV sliding window (86400s), 플랜별 일일 상한 (§11 참조).

### D. 테스트 스크립트

| 파일 | 내용 |
|------|------|
| `scripts/test-bnb-eip7702.mjs` | BNB Chain EIP-7702 E2E 테스트 |
| `scripts/test-eth-eip7702.mjs` | Ethereum EIP-7702 + USDC 잔고 체크 |
| `scripts/agent-example.mjs` | Node.js Agent SDK — 5체인 워크플로 예제 + 모듈 export |

---

## 18. Stable Chain 통합

### 왜 Q402 on Stable인가

Stable은 USDT0가 네이티브 가스 토큰인 Layer 1. AI 에이전트 생태계에서:
- 에이전트마다 USDT0 잔고를 따로 관리해야 하는 운영 부담 해소
- 단일 Gas Tank로 수백 에이전트 통합 가스 관리
- USD 페그 가스 → 릴레이어 운영비 예측 가능 (변동성 없음)

### 네트워크 정보

| 항목 | Mainnet (사용) | Testnet |
|------|---------|---------|
| Chain ID | `988` | `2201` |
| RPC | `https://rpc.stable.xyz` | `https://rpc.testnet.stable.xyz` |
| Explorer | `https://stablescan.xyz` | `https://testnet.stablescan.xyz` |
| 가스 토큰 | USDT0 (18 dec) | USDT0 |
| USDT0 주소 | `0x5FD84259d66Cd46123540766Be93DFE6D43130D7` | `0x78Cf24370174180738C5B8E352B6D14c83a6c9A9` |

### 배포된 컨트랙트

| Network | Address |
|---------|---------|
| Stable Mainnet (988) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| Stable Testnet (2201) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |

> 같은 주소 — deployer 주소/nonce 동일, deterministic 배포.

### EIP-712 도메인

```javascript
{
  name:              "Q402 Stable",
  version:           "1",
  chainId:           988,
  verifyingContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350"  // impl (X Layer와 달리 EOA 아님)
}
```

### Partnership

- 파트너: Stable 팀 (Eunice, @eunicecyl)
- 발표: 2026-04-04 Twitter 공동 포스팅 ✅
- 메인넷 배포 완료: 2026-04-04 ✅
- Sourcify 검증: 미완료

---

## 19. 컨트랙트 & 토큰 주소

### 릴레이 컨트랙트

| 체인 | ChainID | 주소 | EIP-712 NAME | 검증 |
|------|---------|------|-------------|------|
| Avalanche | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | Q402 Avalanche | ✅ Routescan |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | Q402 BNB Chain | ✅ Sourcify |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | Q402 Ethereum | ✅ Sourcify |
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | Q402 X Layer | ✅ OKLink |
| **Stable** | **988** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Q402 Stable | ⏳ 미검증 |

### 토큰 주소

#### Avalanche
| 토큰 | 주소 | Dec |
|------|------|-----|
| USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 |
| USDT | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | 6 |

#### BNB Chain
| 토큰 | 주소 | Dec | 비고 |
|------|------|-----|------|
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | Binance 래핑, EIP-2612 미지원 |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 | |

#### Ethereum
| 토큰 | 주소 | Dec |
|------|------|-----|
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |

#### X Layer
| 토큰 | 주소 | Dec | 비고 |
|------|------|-----|------|
| USDC | `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | 6 | EIP-2612 + EIP-3009 지원 |
| USDT | `0x1E4a5963aBFD975d8c9021ce480b42188849D41D` | 6 | |

#### Stable
| 토큰 | 주소 | Dec |
|------|------|-----|
| USDT0 | `0x5FD84259d66Cd46123540766Be93DFE6D43130D7` | 18 |

### 컨트랙트 ABI 요약

```solidity
// EIP-7702로 위임된 EOA에서 실행
function pay(
  address owner,           // 결제자 EOA
  address token,           // USDC/USDT 토큰 주소
  uint256 amount,          // atomic (USDC: 1 = 0.000001)
  address to,              // 수신자
  uint256 deadline,        // 만료 타임스탬프
  uint256 nonce,           // 랜덤 uint256 (replay 방지)
  bytes calldata witnessSig // EIP-712 TransferAuthorization 서명
) external;
```

---

## 20. 보안

### 보안 속성

| 속성 | 구현 |
|------|------|
| API Key 소유권 증명 | EIP-191 personal_sign (provision/rotate/transactions/activate) |
| Replay 방지 | `usedNonces[owner][nonce]` 온체인 mapping |
| Owner Binding | `owner != address(this)` → `OwnerMismatch()` revert |
| Facilitator 검증 | `msg.sender != facilitator` → `UnauthorizedFacilitator()` revert (xlayer) |
| SSRF 방지 | Webhook URL에서 private IP 범위 차단 (RFC-1918 + loopback) |
| Rate limiting | KV sliding-window per IP per endpoint |
| 에러 노출 방지 | 내부 에러 서버 로그, 클라이언트엔 generic 메시지 |
| Sandbox 격리 | `q402_test_` 키는 온체인 미접근, `isSandbox` KV 플래그 |
| Webhook 무결성 | HMAC-SHA256 모든 아웃바운드 페이로드 |
| ECDSA 강화 | low-s 강제 + zero-address 검증 |

### v1.2 보안 감사 이력 (2026-03-23, Marin)

**[P0] Owner Binding 누락 — 치명**  
`transferWithAuthorization`에서 `owner != address(this)` 검증 없음 → 타 주소 자산 무단 이전 가능.
```solidity
if (owner == address(0)) revert InvalidOwner();
if (owner != address(this)) revert OwnerMismatch();
```

**[P1] Facilitator 미검증 — 높음**  
`msg.sender == facilitator` 체크 없음 → 인터셉트된 페이로드 제3자 실행 가능.
```solidity
if (msg.sender != facilitator) revert UnauthorizedFacilitator();
```

**[P2-A] ECDSA 강화 — 중간**  
`ecrecover` zero-address 검증 + low-s malleability 방어 추가.

**[P2-B] EIP-7702 context 주의사항 문서화**  
`domainSeparator()`/`hashTransferAuthorization()`이 위임 실행 컨텍스트에서 `address(this)` 달라짐 → `@dev WARNING` 주석 추가.

**v1.2 재배포:** 4개 체인 전체 재배포, Sourcify/Routescan/OKLink 검증 완료.

---

## 21. Vercel 배포

```bash
npm install -g vercel
cd Q402-Institutional
vercel link --project q402-institutional --scope bitgett-7677s-projects --yes

# 환경변수 추가 예시
echo "0x주소" | vercel env add STABLE_IMPLEMENTATION_CONTRACT production

# 배포는 git push로 자동
git push origin main
```

---

## 22. 릴레이어 지갑

| 항목 | 값 |
|------|----|
| 주소 | `0xfc77ff29178b7286a8ba703d7a70895ca74ff466` |
| 역할 | 모든 체인 가스 대납 (Gas Tank) |
| 프라이빗 키 | `q402-avalanche/.env`의 `DEPLOYER_PRIVATE_KEY` |

**마스터 계정** (항상 paid 처리):
```
0xfc77ff29178b7286a8ba703d7a70895ca74ff466  (릴레이어)
0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28  (오너)
```
`app/lib/access.ts`의 `MASTER_ADDRESSES` 배열에 하드코딩.

---

## 23. 테스트 스크립트 & Agent SDK

```bash
# BNB Chain EIP-7702 E2E 테스트
node scripts/test-bnb-eip7702.mjs

# Ethereum EIP-7702 E2E 테스트 (USDC 잔고 체크 포함)
node scripts/test-eth-eip7702.mjs

# 전체 5체인 Agent 예제
node scripts/agent-example.mjs
```

`agent-example.mjs`는 모듈로 import 가능:
```javascript
import { sendGaslessPayment, CHAINS } from "./scripts/agent-example.mjs";

// 단일 결제
await sendGaslessPayment({ chain: "bnb", recipient: "0x...", amountUSD: 10.0 });

// 멀티체인 순차 결제
for (const chain of ["avax", "bnb", "eth"]) {
  await sendGaslessPayment({ chain, recipient: "0x...", amountUSD: 0.05 });
}
```

환경변수: `.env.local`에 `Q402_API_KEY`, `TEST_PAYER_KEY` 필요.

---

## 24. 남은 작업 / 로드맵

| 항목 | 현황 | 우선순위 |
|------|------|---------|
| Stable 컨트랙트 Sourcify 검증 | 미완료 | 높음 |
| Stable 메인넷 Gas Tank 충전 | 0.12 USDT0 (부족) | 높음 |
| quackai.ai/q402 도메인 연결 | 미완료 | 중간 |
| Webhook retry on failure | fire-and-forget | 중간 |
| 프로젝트별 별도 릴레이어 주소 | 단일 글로벌 지갑 | 높음 (P1) |
| SDK npm 패키지 | CDN 파일만 | 낮음 |
| 자동화 테스트 (Jest/Vitest) | 미구현 | 중간 |
| PostgreSQL 마이그레이션 | Vercel KV로 충분 | 낮음 |
| Gas Tank 자동 충전 | UI 토글 존재, 로직 미구현 | 중간 |

---

## 25. Changelog

### v1.6 (2026-04-09)
- **Fix**: KV TX 이력 월별 키 샤딩 — 1MB 폭발 방지, 누적 가스 합계 별도 키
- **Fix**: 구독 갱신 시 기존 API Key 보존 (통합 깨짐 방지)
- **Fix**: 갱신 만료일 현재 만료일 기준 +30일 연장 (누적 갱신)
- **Fix**: 플랜별 일일 릴레이 버스트 한도 (86400s window)
- **Fix**: Gas Tank Stable 체인 USDT0 전용 입금 안내 UI
- **Scripts**: `test-bnb-eip7702.mjs`, `test-eth-eip7702.mjs`, `agent-example.mjs`

### v1.5 (2026-04-09)
- **Page**: `/agents` — SVG 에이전트 네트워크 애니메이션, 실시간 TX 피드, Contact Sales 모달
- **UX**: Navbar "Agents" 링크 (초록색)
- **Pricing**: Agent 플랜 카드 → `/agents` 페이지 CTA 스트립으로 교체

### v1.4 (2026-04-08)
- **Feature**: Sandbox 모드 (`q402_test_` prefix, mock relay)
- **Feature**: Webhook 시스템 (HMAC-SHA256, SSRF 방어)
- **Feature**: API Key 교체 (`POST /api/keys/rotate`)
- **Fix**: `gasCostNative` 실제 receipt에서 계산 (`effectiveGasPrice × gasUsed`)
- **Fix**: Transactions 탭 인증 방식 → EIP-191 sig
- **Fix**: Dashboard 구독 만료일 초기화 버그
- **Docs**: CODEX.md 삭제, README + Q402_IMPLEMENTATION.md에 통합

### v1.3 (2026-04-08)
- **Feature**: `/payment` 4단계 셀프서브 온체인 결제 플로우
- **Feature**: API Key 온체인 결제 후 자동 발급
- **UX**: 지갑 연결 모달 개선, Dashboard "Not yet activated" → "Loading…"

### v1.2 (2026-04-07)
- **Feature**: Stable 체인 (Chain ID 988, USDT0) 릴레이/Gas Tank/SDK 추가
- **Feature**: Telegram 문의 알림
- **Security**: 4개 체인 컨트랙트 전체 재배포 (v1.2 감사 수정사항 반영)

### v1.1 (2026-03-19)
- **Security**: API Key 누출 취약점 수정
- **Security**: Admin 엔드포인트 `x-admin-secret` 보호
- **Security**: Relay 구독 만료 + 키 교체 검증 강화
- **DB**: JSON 파일 → Vercel KV 마이그레이션
- **Feature**: 결제 페이월 제거, Quote Builder + Direct Inquiry 팝업

### v1.0 (2026-03-14)
- 랜딩 페이지, 대시보드, Relay API 초기 배포 (4개 체인)
