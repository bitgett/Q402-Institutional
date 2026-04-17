# Q402 — Gasless Payment Infrastructure

> Multi-chain ERC-20 gasless payment relay for DeFi applications and AI agents.  
> Users pay USDC/USDT with zero gas — Q402 relayer covers all transaction fees.

**Version: v1.3.1** · **Docs revision: v1.16** · **Last updated: 2026-04-17**  
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

**모든 5개 체인 — 통합 EIP-7702 플로우:**
```
User clicks "Pay USDC"
  → SDK: GET /api/relay/info (facilitator 주소 조회)
    → EIP-712 TransferAuthorization witnessSig (verifyingContract = user EOA)
    → EIP-7702 authorization 서명 (2 sigs 총 2회)
      → POST /api/relay { witnessSig, authorization }
        → Q402 relayer: Type 4 TX 제출 (가스 대납)
          → 위임된 Q402PaymentImplementation.transferWithAuthorization() 실행
            → USDC/USDT(0): user EOA → recipient
```

> 5개 체인 모두 동일한 witness 타입 `TransferAuthorization(owner, facilitator, token, recipient, amount, nonce, deadline)`과
> 동일한 `verifyingContract = user EOA` 규칙을 사용한다. 체인별 차이는 `domainName`(예: "Q402 Avalanche")과
> impl 주소뿐.
>
> X Layer는 레거시 EIP-3009 fallback도 지원 — `eip3009Nonce` 전달 시 자동 선택 (**USDC only**).

---

## 3. Supported Chains

| Chain | ChainID | 릴레이 방식 | 컨트랙트 | 상태 |
|-------|---------|-----------|---------|------|
| Avalanche C-Chain | 43114 | EIP-7702 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | ✅ |
| BNB Chain | 56 | EIP-7702 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | ✅ |
| Ethereum | 1 | EIP-7702 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | ✅ |
| X Layer | 196 | EIP-7702 + EIP-3009 USDC fallback | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | ✅ |
| **Stable** | **988** | **EIP-7702** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | ✅ |

> Stable 특이사항: USDT0가 가스 토큰이자 결제 토큰 (네이티브 코인 = USD 페그).

> **Single source of truth**: 체인별 컨트랙트 · 도메인 · witness 타입 · 토큰 매핑은
> [`contracts.manifest.json`](./contracts.manifest.json)에 canonical 형태로 정리돼 있다.
> 서버(`app/lib/relayer.ts`) · SDK(`public/q402-sdk.js`) · 이 문서 값이 드리프트될 경우
> 매니페스트가 최종 진실이며, `__tests__/contracts-manifest.test.ts`가 일치성을 검증한다.

---

## 4. Tech Stack

| 항목 | 기술 |
|------|------|
| Framework | Next.js 16 App Router (React 19, TypeScript) |
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

# 컨트랙트 주소 (v1.3). AVAX는 historical name `IMPLEMENTATION_CONTRACT`도 허용됨.
AVAX_IMPLEMENTATION_CONTRACT=0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c
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
│   ├── test-eip7702.mjs            # 통합 EIP-7702 E2E 테스트 (--chain avax|bnb|eth|xlayer|stable)
│   └── agent-example.mjs           # Node.js Agent SDK (5체인 통합 예제 — TransferAuthorization)
└── public/
    ├── q402-sdk.js                 # 클라이언트 SDK v1.3.1
    ├── bnb.png / eth.png / avax.png / xlayer.png / stable.jpg
    └── arbitrum.png / scroll.png
```

---

## 7. Payment Flow

`/payment` 페이지는 셀프서브 온체인 결제 → API Key 자동 발급 플로우:

1. **체인 선택** — 어떤 체인에서 릴레이할 것인가? (체인마다 가격 다름)
2. **TX 수 선택** — 이번에 구매할 가스리스 TX 건수
3. **지갑 연결** — MetaMask or OKX Wallet
4. **송금 + 검증** — Q402 주소(`0xfc77...`)로 USDC/USDT 전송 후 "Verify" 클릭 → API Key 자동 발급

**결제 모델 (v1.9):**
- **첫 결제** → 플랜 등급 설정 + TX 건수 추가 + 30일 기간 시작
- **추가 결제** → TX 건수 추가 + 30일 연장 (플랜 등급 유지, 기간 스택됨)
- TX 크레딧은 릴레이 1건당 1 차감. 만료일 도달 또는 크레딧 소진 시 정지.

**체인별 가격 (BNB 기준, 체인마다 multiplier 적용):**
| TX 수 | BNB/XLayer/Stable (1.0×) | AVAX (1.1×) | ETH (1.5×) |
|-------|--------------------------|-------------|------------|
| 500   | $30 | $30 | $40 |
| 1,000 | $50 | $50 | $70 |
| 5,000 | $90 | $100 | $130 |
| 10,000 | $150 | $160 | $220 |
| 50,000 | $450 | $490 | $670 |
| 100,000 | $800 | $880 | $1,200 |

결제 수단: **BNB USDC, BNB USDT, ETH USDC, ETH USDT** (구독 결제는 BNB/ETH 체인만, 의도적)  
결제 주소: `0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` (SUBSCRIPTION 콜드 지갑 — 매출 전용)

---

## 8. SDK Usage

### 브라우저

```html
<script src="https://q402-institutional.vercel.app/q402-sdk.js"></script>
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

// Stable — token key is "USDT" (resolves to USDT0 on-chain), amount in USDT0 units
const q402s = new Q402Client({ apiKey: "q402_live_xxx", chain: "stable" });
const result3 = await q402s.pay({ to: "0xRecipient", amount: "10.00", token: "USDT" });
```

SDK: **v1.3.1** — 5개 체인 지원 (avax, bnb, eth, xlayer, stable)

> **⚠ `amount` 파라미터 규칙** — 반드시 **human-readable decimal 문자열** ("5.00", "0.123456")로
> 전달할 것. 내부적으로 `ethers.parseUnits(amount, decimals)`로 정확히 변환되며, 토큰 decimals를
> 초과하는 정밀도(예: 6-dec USDC에 "5.1234567")나 숫자/지수 표기는 명시적으로 throw한다.
> JS `Number`를 그대로 넘기면 18-dec 토큰에서 IEEE-754 정밀도 손실이 발생하기 때문.

### Node.js Agent

`scripts/agent-example.mjs`를 모듈로 import:

```javascript
import { sendGaslessPayment } from "./scripts/agent-example.mjs";

const result = await sendGaslessPayment({
  chain:      "avax",   // "avax" | "bnb" | "eth" | "xlayer" | "stable"
  recipient:  "0x...",
  amount:     "10.0",   // decimal string — Number is rejected (IEEE-754 safety)
});
console.log(result.txHash);
```

### SDK 내부 동작

**5개 체인 공통 — EIP-7702 (`method: "eip7702" | "eip7702_xlayer" | "eip7702_stable"`)**
```
q402.pay() 호출
  ├─ 0. GET /api/relay/info → facilitator 주소
  ├─ 1. EIP-712 witnessSig 서명
  │      domain: { name: "Q402 <Chain>", version: "1", chainId, verifyingContract: 유저 EOA }
  │      types:  TransferAuthorization { owner, facilitator, token, recipient, amount, nonce, deadline }
  ├─ 2. EIP-7702 authorization 서명
  │      { address: implContract, nonce: EOA_nonce }
  └─ 3. POST /api/relay { witnessSig, authorization, <chain-specific nonce field> }
         avax/bnb/eth → nonce   |   xlayer → xlayerNonce   |   stable → stableNonce
```

**X Layer EIP-3009 fallback (USDC only)** — `eip3009Nonce` 제공 시만 선택됨.

---

## 9. API Reference

### POST /api/relay

EIP-712 + EIP-7702 페이로드 제출 → 가스리스 릴레이.  
`apiKey` 필수, 구독 만료 및 키 교체 검증.

**공통 필드** (모든 체인):
- `token`: **심볼 문자열** `"USDC"` 또는 `"USDT"` — 절대 주소가 아님. 서버가 `CHAIN_CONFIG[chain][token]`으로 주소를 조회함.
- `amount`: atomic uint256 문자열 (예: 0.05 USDC @ 6dp → `"50000"`)
- `witnessSig`: EIP-712 TransferAuthorization 서명
- `authorization`: EIP-7702 위임 증명 `{ chainId, address, nonce, yParity, r, s }`
- **nonce 필드명은 체인별로 다름** (아래 참조)

**avax / bnb / eth 요청** (nonce 필드: `nonce`):
```json
{
  "apiKey":        "q402_live_xxx",
  "chain":         "avax",
  "token":         "USDC",
  "from":          "0xPayerEOA",
  "to":            "0xRecipient",
  "amount":        "50000",
  "deadline":      1712345678,
  "nonce":         "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 43114, "address": "0x96a8...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**xlayer EIP-7702 요청** (nonce 필드: `xlayerNonce`):
```json
{
  "apiKey": "q402_live_xxx", "chain": "xlayer", "token": "USDC",
  "from": "0x...", "to": "0x...", "amount": "50000", "deadline": 1712345678,
  "xlayerNonce":   "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 196, "address": "0x8D85...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**stable EIP-7702 요청** (nonce 필드: `stableNonce`, token은 "USDC"/"USDT" 모두 USDT0로 라우팅):
```json
{
  "apiKey": "q402_live_xxx", "chain": "stable", "token": "USDC",
  "from": "0x...", "to": "0x...", "amount": "50000000000000000", "deadline": 1712345678,
  "stableNonce":   "98237498237492834",
  "witnessSig":    "0x...",
  "authorization": { "chainId": 988, "address": "0x2fb2...", "nonce": 0, "yParity": 0, "r": "0x...", "s": "0x..." }
}
```

**xlayer EIP-3009 fallback:** `authorization`/`xlayerNonce` 대신 `eip3009Nonce` (bytes32 hex). **USDC only** — USDT는 EIP-7702 경로를 사용해야 함.

> **Authorization 잠금 (v1.3+)**: 서버는 `authorization.chainId`와 `authorization.address`가
> `contracts.manifest.json`의 해당 체인 공식 impl contract와 정확히 일치하지 않으면 400을 반환한다.

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
**사전 조건**: `POST /api/payment/intent` 로 결제 의도 기록 필요.  
**인증**: 일회용 fresh challenge (`GET /api/auth/challenge`) 서명 필요.

```json
// 요청
{
  "address": "0x...",
  "challenge": "<GET /api/auth/challenge 에서 받은 값>",
  "signature": "0x...",
  "txHash": "0x..."   // optional — 제공 시 블록 스캔 대신 단일 TX 직접 검증
}
// 응답 (공통)
{
  "status": "activated",
  "plan": "starter",
  "addedTxs": 500,
  "totalTxs": 500,
  "expiresAt": "2026-05-13T00:00:00.000Z"
}
```
- 첫 결제: `plan` 설정 + `addedTxs` 추가 + 30일 시작
- 추가 결제: 기존 `plan` 유지 + `totalTxs` 누적 + 30일 연장
- challenge는 단 1회만 유효 (consumed 후 재사용 불가 — replay 방지)

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

**하이브리드 EIP-191 personal_sign** — 세션 nonce (1h TTL) + 고위험 액션 fresh challenge:

```
서명 메시지: "Q402 Auth\nAddress: {address_lowercase}\nNonce: {nonce}"
nonce: GET /api/auth/nonce?address=0x...  → { nonce, expiresIn: 3600 }
```

**플로우:**
1. `GET /api/auth/nonce?address=0x...` → 서버가 KV에 nonce 저장 (1시간 TTL — `app/lib/auth.ts` `NONCE_TTL_SEC`)
2. 클라이언트가 서명 → `sessionStorage["q402_auth_0xaddr"]`에 `{nonce, signature}` 캐시 (55분 TTL, 서버보다 5분 일찍 만료시켜 race 방지 — `app/lib/auth-client.ts` `CLIENT_NONCE_TTL_MS`)
3. 모든 보호 요청에 `{address, nonce, signature}` 전달
4. 서버: `verifyNonceSignature(addr, nonce, sig)` — nonce KV 검증 + ECDSA 검증
5. 401 `NONCE_EXPIRED` 수신 시: 클라이언트 캐시 삭제 → 다음 요청에서 재서명

**키 로테이션 후** `invalidateNonce(addr)` 호출 → 다음 민감한 요청에서 강제 재서명.

**적용 엔드포인트:**
- `POST`: `/api/keys/provision`, `/api/keys/rotate`, `/api/payment/activate`, `/api/payment/intent`
- `POST`: `/api/webhook` (등록/수정/삭제), `/api/webhook/test`
- `GET` (쿼리파라미터): `/api/transactions?address=&nonce=&sig=`, `/api/webhook?address=&nonce=&sig=`

---

## 11. Subscription Plans & Rate Limits

### TX 크레딧 모델 (v1.9)

구독은 **플랜 등급 + TX 크레딧 잔여량 + 만료일** 3가지로 관리됨.

- **플랜 등급**: 첫 결제 시 결제 금액 기준으로 설정. 이후 변경 불가.
  - 플랜은 일일 버스트 한도(Gas Tank 독점 방지)에만 영향.
- **TX 크레딧**: 매 결제마다 추가. 릴레이 1건 성공 시 1 차감. 0 이하면 429.
- **만료일**: 매 결제마다 +30일 연장 (기간 중 결제 시 현재 만료일 기준으로 누적).

| Plan (첫 결제 금액 기준) | TX 크레딧 | 일일 버스트 한도 |
|--------------------------|----------|----------------|
| Starter ($30~) | 500 | 50/day |
| Basic ($50~) | 1,000 | 100/day |
| Growth ($90~) | 5,000 | 1,000/day |
| Pro ($150~) | 10,000 | 1,000/day |
| Scale ($450~) | 50,000 | 10,000/day |
| Business ($800~) | 100,000 | 10,000/day |
| Enterprise Flex ($2,000~) | 500,000 | 무제한 |
| **Agent** | **무제한** | **무제한** | Gas Tank 선불, `/agents` 참조 |

일일 한도 초과 시: `HTTP 429 Daily relay cap reached for plan {plan}` (86400s window)  
TX 크레딧 소진 시: `HTTP 429 No TX credits remaining`  
Sandbox 키는 한도/크레딧 적용 안 함.

### API Rate Limits

| Endpoint | IP 기준 | API Key 기준 |
|----------|---------|------------|
| /api/relay | 60 req/60s | **30 req/60s** (v1.8 추가) |
| /api/keys/provision | 10 req/60s |
| /api/keys/rotate | 5 req/60s |
| /api/payment/activate | 5 req/60s |
| /api/payment/check | 30 req/60s |
| /api/transactions | 30 req/60s |
| /api/webhook | 10 req/60s |
| /api/inquiry | 3 req/600s |
| /api/inquiry (GET admin) | **5 req/60s** (v1.9 추가) |
| /api/grant (GET admin) | **5 req/60s** (v1.9 추가) |
| /api/gas-tank/withdraw | **5 req/60s** (v1.9 추가) |
| /api/gas-tank/user-balance | 30 req/60s (v1.9 추가) |

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
- **크레딧 체크 (v1.9):** `subscription.quotaBonus > 0` 단일 조건 (월별 카운트 불필요)
- 잔고 계산: `getGasBalance()` → 입금배열 + 누적합계 2 read만 필요

### 데이터 구조

**Subscription**
```json
{
  "paidAt":        "2026-04-09T00:00:00.000Z",  // 만료 기산점 (결제마다 갱신)
  "apiKey":        "q402_live_xxx",
  "sandboxApiKey": "q402_test_xxx",
  "plan":          "growth",                     // 첫 결제 시 설정, 이후 변경 없음
  "txHash":        "0xOnChainPaymentTxHash",     // 최근 결제 TX
  "amountUSD":     150,
  "quotaBonus":    9850                          // 남은 TX 크레딧 (릴레이마다 -1)
}
```
> `paidAt` + 30일 = 만료일. 결제 시마다 현재 만료일 기준 +30일 연장.  
> `quotaBonus` = 릴레이 가능 잔여 TX 수. 0 이하면 relay 429 반환.

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

### 13-A. EIP-7702 (공통, 5개 체인 동일)

```
유저 EOA ──(EIP-7702 authorization)──▶ Q402PaymentImplementation
                                         .transferWithAuthorization() 실행 시
                                         _domainSeparator()의 address(this)가
                                         유저 EOA로 resolve됨 (그래서 verifyingContract = EOA)
```

**EIP-712 서명 도메인 (5개 체인 공통 규칙):**
```javascript
{
  name:              "Q402 Avalanche",   // 체인별: Avalanche | BNB Chain | Ethereum | X Layer | Stable
  version:           "1",
  chainId:           43114,              // 체인별
  verifyingContract: userEOA,            // ⭐ 모든 체인 동일 — 절대 impl 주소 아님
}

// types — 5개 체인 모두 동일
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

**컨트랙트 측 불변식:**
- `owner == address(this)` 검증 (Owner Binding, P0 감사 대응)
- `msg.sender == facilitator` 검증 (Unauthorized Facilitator 방어, P1 감사 대응)
- `usedNonces[owner][nonce]` 매핑으로 replay 방지
- `_domainSeparator()` 가 `address(this)`를 사용 → EIP-7702 위임 컨텍스트에서 유저 EOA로 resolve

**viem Type 4 TX 전송 (`app/lib/relayer.ts`):**
```typescript
const txHash = await walletClient.sendTransaction({
  chain: null,
  to:   params.owner,                    // 유저 EOA
  data: callData,                        // transferWithAuthorization() calldata
  gas:  BigInt(300000),
  authorizationList: [{ ...params.authorization }],
});
```

**가스 비용 계산:**
```typescript
const gasCostNative = parseFloat(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));
```

### 13-B. 체인별 차이점 요약

| 항목 | avax / bnb / eth | xlayer | stable |
|------|------------------|--------|--------|
| 컨트랙트 클래스 | `Q402PaymentImplementation` | `Q402PaymentImplementationXLayer` | `Q402PaymentImplementationStable` |
| 진입 함수 | `transferWithAuthorization()` | `transferWithAuthorization()` | `transferWithAuthorization()` |
| witness 타입 | TransferAuthorization | TransferAuthorization | TransferAuthorization |
| `verifyingContract` | 유저 EOA | 유저 EOA | 유저 EOA |
| 도메인 이름 | "Q402 Avalanche" / "Q402 BNB Chain" / "Q402 Ethereum" | "Q402 X Layer" | "Q402 Stable" |
| EIP-3009 fallback | ✗ | ✓ (USDC only, 레거시) | ✗ |
| 릴레이 API `method` | `"eip7702"` | `"eip7702_xlayer"` / `"eip3009"` | `"eip7702_stable"` |

> 역사적 메모: v1.3.0 이전에는 avax/bnb/eth가 `PaymentWitness`라는 별개 witness 타입을 썼다고 문서화돼 있었지만,
> 실제 배포된 컨트랙트는 5개 체인 모두 `TransferAuthorization` + `_domainSeparator(address(this))` 단일 스킴이다.
> v1.14 문서 리비전에서 SDK/manifest/tests/docs가 모두 이 배포 현실에 맞춰졌다.

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
4. **TX 크레딧 확인** (`subscription.quotaBonus > 0`, 0 이하 → 429) — v1.9
5. Gas Tank 잔고 확인 (`getGasBalance[chain] > 0.0001`)
6. 체인 분기:
   - xlayer + `authorization+xlayerNonce` → `settlePaymentXLayerEIP7702()`
   - xlayer + `eip3009Nonce` → `settlePaymentEIP3009()`
   - 기타 → `settlePayment()`
7. TX 기록 (`recordRelayedTx` — 월별 배열 + 누적합계) + **크레딧 1 차감** (fire-and-forget)
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

등록/테스트/발송 시 모두 검증 (v1.8 강화):
```
RFC-1918:    10.x, 172.16-31.x, 192.168.x, 127.x, localhost, 0.0.0.0
IPv6 내부:  ::1, ::ffff:, fe80:, fc00:, fd__:
클라우드:   metadata.google.internal, 169.254.169.254, fd00:ec2::254
Octal IP:   0177.0.0.1 형식 차단
Production: HTTP(비HTTPS) 차단
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

유저가 **GASTANK** 콜드 주소(`GASTANK_ADDRESS`)로 native token을 입금 → 릴레이 비용으로 차감. 릴레이어 핫 주소는 별개로, GASTANK→RELAYER 이체는 운영자가 수동/스크립트로 수행.

**입금 스캔 (기본):** `POST /api/gas-tank/verify-deposit` — `{ address }`
- 5개 체인에서 배치 RPC 블록 스캔 (BNB/AVAX/XLayer: 200블록, ETH: 50블록, Stable: 500블록)
- `from=유저, to=GASTANK, value≠0` 필터 → `addGasDeposit()`
- 스캔 창 바깥(ETH 기준 ~10분, 그 외 최대 수십분)에서 돌아온 유저는 이 경로로 크레딧되지 않음 → 아래 직접 조회 경로 사용

**입금 직접 조회 (복구 경로):** `POST /api/gas-tank/verify-deposit` — `{ address, txHash, chain }`
- `chain`: `"bnb" | "eth" | "avax" | "xlayer" | "stable"`
- `eth_getTransactionByHash`로 단일 TX 직접 검증 (컨펌 완료 + `to=GASTANK` + `from=address` + `value>0`)
- 블록 창 밖에서도 동작. 중복 txHash는 `addGasDeposit` SADD로 자동 차단 (`alreadyCredited: true`)
- 대시보드 Deposit 모달의 "not_found" 상태에서 UI 필드 노출

**잔고 조회:** `GET /api/gas-tank/user-balance?address=0x...`

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
| `scripts/test-eip7702.mjs` | 통합 EIP-7702 E2E 테스트 — `--chain avax\|bnb\|eth\|xlayer\|stable` |
| `scripts/agent-example.mjs` | Node.js Agent SDK — 5체인 통합 예제 (TransferAuthorization + 모듈 export) |

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
| Explorer | `https://stablescan.org` | `https://testnet.stablescan.xyz` |
| 가스 토큰 | USDT0 (18 dec) | USDT0 |
| USDT0 주소 | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | `0x78Cf24370174180738C5B8E352B6D14c83a6c9A9` |

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
  verifyingContract: userEOA,   // 5개 체인 공통 — _domainSeparator가 address(this) 사용
}
```

### Partnership

- 파트너: Stable 팀 (Eunice, @eunicecyl)
- 발표: 2026-04-04 Twitter 공동 포스팅 ✅
- 메인넷 배포 완료: 2026-04-04 ✅
- 컨트랙트 검증: ✅ stablescan.xyz 검증 완료 (2026-04-13)

---

## 19. 컨트랙트 & 토큰 주소

### 릴레이 컨트랙트

| 체인 | ChainID | 주소 | EIP-712 NAME | 검증 |
|------|---------|------|-------------|------|
| Avalanche | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | Q402 Avalanche | ✅ Routescan |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | Q402 BNB Chain | ✅ Sourcify |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | Q402 Ethereum | ✅ Sourcify |
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | Q402 X Layer | ✅ OKLink |
| **Stable** | **988** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Q402 Stable | ✅ Stablescan |

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
| 토큰 | 주소 | Dec | 비고 |
|------|------|-----|------|
| USDT0 | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | 18 | API의 `USDC`/`USDT` 키 모두 이 주소로 resolve |

### 컨트랙트 ABI 요약 (5개 체인 공통)

```solidity
// EIP-7702로 위임된 EOA에서 실행 — msg.sender = facilitator(릴레이어), address(this) = owner(유저 EOA)
function transferWithAuthorization(
  address owner,            // 결제자 EOA (address(this)와 일치해야 함)
  address facilitator,      // 릴레이어 주소 (msg.sender와 일치해야 함)
  address token,            // USDC/USDT(Stable은 USDT0) 토큰 주소
  address recipient,        // 수신자
  uint256 amount,           // atomic (체인별 decimals)
  uint256 nonce,            // 랜덤 uint256 (usedNonces 매핑으로 replay 방지)
  uint256 deadline,         // 만료 타임스탬프
  bytes calldata witnessSignature  // EIP-712 TransferAuthorization 서명
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
| SSRF 방지 | Webhook URL 등록/발송 시 RFC-1918 + IPv6 내부 + 클라우드 메타데이터 차단 |
| Rate limiting | KV sliding-window per IP **and per API key** (/api/relay: 30 req/60s per key) |
| 에러 노출 방지 | 내부 에러 서버 로그, 클라이언트엔 generic 메시지 |
| Sandbox 격리 | KV `isSandbox` 플래그만 신뢰 — key prefix 기반 우회 차단 |
| TX 재사용 방지 | `used_txhash:{hash}` KV 플래그 (90일 TTL) — 동일 TX 재활성화 불가 |
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

## 22. 운영 지갑 — 3-역할 분리 (v1.16+)

3개 지갑, 3개 역할, 0개 commingling. 단일 키 컴프로마이즈로 매출/유저 예치금이 한 번에 털리지 않도록 분리.

| 역할 | 주소 | 키 보관 | 책임 |
|------|------|---------|------|
| `SUBSCRIPTION_ADDRESS` | `0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` | **콜드** (서버에 키 없음) | 구독 결제 ($29/$49/$149…) 수신만. 정기적으로 콜드 디바이스에서 수동 인출. |
| `GASTANK_ADDRESS`      | `0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a` | **콜드** (서버에 키 없음) | 유저 가스 예치금(BNB/ETH/AVAX/OKB/USDT0) 수신. 핫 릴레이어로 cold→hot 수동 충전. |
| `RELAYER_ADDRESS`      | `0xfc77ff29178b7286a8ba703d7a70895ca74ff466` | **핫** (Vercel `RELAYER_PRIVATE_KEY`) | EIP-7702 TX 서명/제출. 최소 운영 잔고만 유지 (BNB/ETH/AVAX/OKB/USDT0). |

상수는 [`app/lib/wallets.ts`](app/lib/wallets.ts) 단일 모듈에서 export — 모든 라우트/페이지가 여기서만 import.

### 핵심 보안 인바리언트

1. **`RELAYER_ADDRESS`는 유저 자금을 수신하지 않는다.** 가스 예치는 `GASTANK_ADDRESS`로, 구독 결제는 `SUBSCRIPTION_ADDRESS`로. 서버 컴프로마이즈 시 빠지는 건 RELAYER의 운영 가스 float뿐.
2. **`GASTANK_ADDRESS`의 프라이빗 키는 절대 Vercel env에 올리지 않는다.** Cold 서명만 — 유저 환불(`/api/gas-tank/withdraw`)도 record-only로, 운영자가 콜드 디바이스에서 송금한 뒤 txHash 만 서버에 기록한다.
3. **온체인 GASTANK 잔고 == sum(KV `gas:` ledger)** (체인별). [`scripts/migrate-split-wallets.mjs`](scripts/migrate-split-wallets.mjs)로 정기 검증.
4. **`RELAYER_ADDRESS` 상수 == `RELAYER_PRIVATE_KEY` 파생 주소.** `app/lib/relayer-key.ts`의 `loadRelayerKey()`가 모든 서명 호출 직전에 검증, 불일치 시 503 fail-closed. 회귀 테스트는 [`__tests__/relayer-key.test.ts`](__tests__/relayer-key.test.ts).

### 알려진 한계 — 유저별 가스 custody

이 분리는 **집계 유저 가스 풀**(콜드 GASTANK 안에 보관)을 보호하지만, **유저별 잔고 귀속**은 여전히 KV ledger (`gas:<userAddr>` 키)로 관리한다. KV 손실/오염/무단 쓰기 시:
- 온체인 GASTANK 총 잔액의 어느 부분이 어느 유저 몫인지 잊을 수 있음
- 단일 유저의 기록 잔고를 온체인과 무관하게 부풀리거나 깎을 수 있음

**총 부채 vs 온체인 GASTANK 잔액**은 체인 히스토리로 검증 가능 (스크립트). 하지만 **유저별 잔고 재구성**은 모든 deposit/relay 이벤트를 체인 로그에서 다시 스캔해야 함. 현재는 유저별 온체인 subaccount 없음. CREATE2 vault per user 도입은 현 TVL 단계에서는 의도적 non-goal — 비용/이점 분석은 §22 트레이드오프 참조.

### 알림

`/api/cron/gas-alert` → `/api/gas-tank?check_alerts=1` (admin secret 필요) 가 RELAYER 핫 잔고를 모니터링하고 운영 임계치 미만이면 텔레그램 경보 발송. 알림이 뜨면 운영자가 콜드(GASTANK) → 핫(RELAYER) 송금.

### 마스터 계정 (항상 paid 처리)
```
0xfc77ff29178b7286a8ba703d7a70895ca74ff466  (RELAYER 핫)
0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28  (오너)
0x3717d6ed5c2bce558e715cda158023db6705fd47  (오너)
```
`app/lib/access.ts`의 `MASTER_ADDRESSES` 배열에 하드코딩 — Quote 페이지/대시보드 화이트리스트.

---

## 23. 테스트 스크립트 & Agent SDK

```bash
# 통합 EIP-7702 E2E 테스트 — 체인 지정
node scripts/test-eip7702.mjs --chain avax   [--amount 0.05] [--to 0x...]
node scripts/test-eip7702.mjs --chain bnb
node scripts/test-eip7702.mjs --chain eth
node scripts/test-eip7702.mjs --chain xlayer
node scripts/test-eip7702.mjs --chain stable

# 5체인 Agent SDK 예제 (TransferAuthorization 통합 플로우)
node scripts/agent-example.mjs
```

`agent-example.mjs`는 모듈로 import 가능:
```javascript
import { sendGaslessPayment, CHAINS } from "./scripts/agent-example.mjs";

// 단일 결제 — amount는 반드시 **문자열** (Number는 거부됨, IEEE-754 안전성)
await sendGaslessPayment({ chain: "bnb", recipient: "0x...", amount: "10.0" });

// 멀티체인 순차 결제
for (const chain of ["avax", "bnb", "eth"]) {
  await sendGaslessPayment({ chain, recipient: "0x...", amount: "0.05" });
}
```

환경변수: `.env.local`에 `Q402_API_KEY`, `TEST_PAYER_KEY` 필요.

---

## 24. 남은 작업 / 로드맵

| 항목 | 현황 | 우선순위 |
|------|------|---------|
| Stable 컨트랙트 검증 | ✅ stablescan.xyz 완료 (2026-04-13) | 완료 |
| Gas Tank 충전 (전 체인 low) | BNB / ETH / AVAX / XLayer / Stable 저잔고 | 즉시 필요 |
| quackai.ai/q402 도메인 연결 | 미완료 | 중간 |
| Webhook retry on failure | fire-and-forget | 중간 |
| 프로젝트별 별도 릴레이어 주소 | 단일 글로벌 지갑 | 높음 (P1) |
| SDK npm 패키지 | CDN 파일만 | 낮음 |
| 자동화 테스트 (Jest/Vitest) | Vitest — `__tests__/` 8 파일 / 122 테스트 (contracts-manifest · relay-body-shape · auth · blockchain · intent · quote · rotate · ratelimit) | 완료 |
| PostgreSQL 마이그레이션 | Vercel KV로 충분 | 낮음 |
| Gas Tank 자동 충전 | UI 토글 존재, 로직 미구현 | 중간 |

---

## 25. Changelog

### v1.16 (2026-04-17)

> **현재 canonical flow 유지 (v1.15와 동일):** 5개 체인 + TransferAuthorization witness + decimal-string `amount`. v1.16은 사용자 눈에 보이는 surface (SSRF 방어, 지갑 플로우, UI 정리)에 집중한 런칭 전 하드닝 라운드.

#### 런칭 전 오딧 결과 반영 — SSRF hardening / UX 수정 / dead code 제거

v1.15 파이프라인 정비에 이어, 모듈별 전체 감사(결제·API·SDK·UI·config)를 돌려 런칭 전 모든 잔여 이슈를 정리. 56개 finding → 15개 실 수정.

**[P0] Webhook SSRF 전반 방어 강화 — `app/lib/webhook-validator.ts` + 신규 `app/lib/safe-fetch.ts`**
- 기존 validator의 여섯 가지 우회 경로를 모두 차단:
  - 2-옥텟/3-옥텟 단축 IPv4 (`127.1`, `10.0.1`) — 숫자-only 호스트 정규식으로 거절
  - `nip.io`, `sslip.io`, `xip.io`, `traefik.me`, `localtest.me` 등 DNS wildcard 서비스
  - DNS resolution 후 실제 IP가 private/loopback이면 거절 (`validateWebhookUrlResolved`)
  - IPv6 embedded IPv4 (`::ffff:127.0.0.1`) 및 cloud-metadata IPv6 (`fd00:ec2::254`)
  - AWS/GCP/Alibaba 메타데이터 호스트 추가 (`metadata.google.internal`, `100.100.100.200`)
- 신규 `safeWebhookFetch()`: 모든 webhook 호출 단일 진입점. `redirect: "manual"`로 redirect 체인 따라가기 차단 + pre-resolve DNS 검증. `/api/webhook/test`와 `/api/relay`(dispatchWebhook)가 공유.
- `/api/webhook/test`: 실패 시 일반화된 `"Webhook delivery failed"`로 응답 (내부 오류 메시지 노출 제거). 원문은 `console.error`로 서버 로그에만 기록.

**[P0] `RegisterModal` 결제 플로우 수정 — `app/components/RegisterModal.tsx`**
- Step 1 "Connect Wallet (MetaMask)" → "Choose Wallet"로 교체 + 공유 `WalletModal` 사용 → OKX 지갑 지원
- "WalletConnect coming soon" 거짓 문구 제거
- `handlePay()` 재작성: `getAuthCreds()`로 nonce + signature 획득 후 `/api/keys/provision` 호출. 실패 케이스별 (서명 거절, 서버 오류, 네트워크 오류) Step 3에 `role="alert"` 에러 UI 노출
- `step` state를 `useRef`로 가드한 effect에서 async 연결 완료 시점에 step 2로 동기화 (이전엔 wallet connect 후 유저가 "Next" 다시 눌러야 했음)

**[P1] `WalletModal` 공유 컴포넌트 추출 — 신규 `app/components/WalletModal.tsx`**
- `WalletButton` + `payment/page.tsx`가 각각 보유하던 duplicated MetaMask-only modal을 단일 컴포넌트로 통합
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` a11y 속성 추가
- ESC 키 close + focus 관리 (useRef/useEffect)
- OKX 아이콘을 `/okx.jpg` 실제 로고로 통일 (`payment/page.tsx`는 이전에 generic grid SVG 사용 중)
- `onConnected?: (address: string) => void` 콜백으로 연결 직후 부모가 step 전환 가능

**[P1] Gas Tank "Auto Top-up" 토글 제거 — `app/dashboard/page.tsx`**
- 로직이 실장된 적 없는 dead UI (토글만 존재, 실제 refill은 수동). 유저에게 "자동 충전됨"이라는 잘못된 인상 줌
- `autoTopup` state + UI 블록 + 활성화 배지 모두 제거. 실제 구현되면 다시 추가

**[P1] Footer X Layer 브랜드 컬러 통일 — `app/components/Footer.tsx`**
- `#7B61FF` (퍼플, 브랜드와 무관) → `#CCCCCC` (silver, 실제 X Layer 로고 컬러). Hero / payment / docs와 일관성

**[P1] Dead code 정리 — `app/lib/access.ts` 삭제 + `WalletContext.isPaidUser` 제거**
- `access.ts`: 과거 페이월 시절 잔재. `isPaid()` 항상 true, `setPaid()` no-op, import 0건
- `WalletContext.isPaidUser`: 모든 consumer 제거 후 타입에도 미사용 필드로 남아있었음 → 타입/프로바이더 양쪽에서 제거

**[P2] 코드 주석 현행화 — `app/lib/relayer.ts`**
- 헤더 주석 `v1.2` → `v1.3` + 5개 체인 통합(stable 포함) 반영
- `transferWithAuthorization()` 주석 `v1.2+` → `v1.3`, calldata 인코딩 주석도 동기화

**[P0] 운영 지갑 3-역할 분리 — 신규 `app/lib/wallets.ts` + 6개 라우트/페이지 마이그레이션**
- 기존: 단일 지갑 `0xfc77ff29...c466`이 (a) 구독 매출 수신, (b) 유저 가스 예치 수신, (c) 핫 릴레이어 서명 — 3 역할 commingle. Vercel env 키 컴프로마이즈 시 매출 + 유저 예치금 + 운영 가스 모두 단일 키 한 방에 노출.
- 신규 분리 (자세한 내용은 §22):
  - `SUBSCRIPTION_ADDRESS = 0x700a873215edb1e1a2a401a2e0cec022f6b5bd71` (콜드, 매출 전용)
  - `GASTANK_ADDRESS      = 0x10fb078594b70ee8024b2ded3d67fc3aa9ea747a` (콜드, 유저 가스 예치)
  - `RELAYER_ADDRESS      = 0xfc77ff29...c466` (핫, EIP-7702 서명만)
- 변경된 파일:
  - `app/payment/page.tsx` — 구독 결제 표시 주소 → `SUBSCRIPTION_ADDRESS`
  - `app/lib/blockchain.ts` — 구독 결제 스캐너 타겟 → `SUBSCRIPTION_ADDRESS` (`Transfer(from, SUBSCRIPTION)` 필터)
  - `app/api/gas-tank/route.ts` — 대시보드는 GASTANK 잔고, 텔레그램 경보는 RELAYER 핫 잔고를 모니터링하도록 분리
  - `app/api/gas-tank/verify-deposit/route.ts` — 유저 예치 스캐너 타겟 → `GASTANK_ADDRESS`
  - `app/api/gas-tank/withdraw/route.ts` — **record-only로 재설계**. RELAYER로 자동 서명하던 기존 로직 제거. 운영자가 콜드 디바이스에서 GASTANK→유저 송금 후 txHash를 POST하면, 서버가 on-chain 검증(from=GASTANK, to=user, value>0, status=1) 후 KV ledger 차감. 검증 실패 시 거절, 중복 txHash 409.
  - `app/dashboard/page.tsx` — Deposit 모달 표시 주소 → `GASTANK_ADDRESS`, 라벨 "Q402 Gas Tank Address"
- 신규 `scripts/migrate-split-wallets.mjs` — read-only 마이그레이션 플랜. 체인별 (legacy 잔고 - KV 가스 부채 - 운영 reserve) 계산해서 운영자가 콜드 디바이스로 서명할 송금 명세를 출력. 키 보유/브로드캐스트 없음.
- **인바리언트**: `RELAYER`는 절대 유저 자금을 받지 않는다. 서버가 털려도 빠지는 건 RELAYER의 작은 운영 가스 float뿐 — 매출/예치금은 안전.

**검증**: `pnpm lint && pnpm build && pnpm test` 모두 통과. webhook-validator 회귀 테스트 추가 (10 개 신규 케이스: nip.io, 2-옥텟 IPv4, metadata host, DNS resolve). 기존 138 테스트 전부 통과.

### v1.15 (2026-04-17)

> **현재 canonical flow (v1.15):** 5개 체인 모두 `TransferAuthorization` witness + `amount` 파라미터(decimal string only). 아래 changelog에 등장하는 `PaymentWitness`, `paymentId`, `amountUSD` 등은 **과거 버전** 용어이며 현재 코드에는 존재하지 않음.

#### 프로덕션 하드닝 — Next 16 / React 19 / lint 파이프라인 / SDK 금액 정밀도 / 레거시 필드 제거

v1.14 체인 통합 이후 같은 날 진행한 런칭 전 정비. 컴파일/린트 파이프라인을 현 세대에 맞추고,
릴레이 계약에서 더는 쓰이지 않는 레거시 입력을 강제로 거절하고, SDK의 금액 변환에서 부동소수점
경로를 완전히 제거했다.

**[P0] SDK 금액 변환 정밀도 복구 — `public/q402-sdk.js` (커밋 `85c8851`)**
- 기존: `BigInt(Math.round(parseFloat(amount) * 10 ** decimals))` — IEEE-754 double이 유효자릿수 15~17개만
  보존하므로 18-dec 토큰(BNB USDC/USDT, Stable USDT0)에서 `"1.000000000000000001"` → `1000000000000000000`
  처럼 dust가 조용히 반올림되던 실버그
- 수정: `toRawAmount(amount, decimals)` 헬퍼 추출 → `ethers.parseUnits` 기반 정확한 decimal-string 파싱
- 입력 검증 강화: 빈 문자열 / whitespace / 비-decimal 문자열 / 지수 표기 / 부호 / 0 / 음수 /
  토큰 decimals 초과 정밀도에 대해 사람이 읽을 수 있는 에러로 throw
- 동작 변경 (breaking for misuse): 이전에 조용히 반올림되던 과잉 정밀도 입력(예: 6-dec USDC에 `"5.1234567"`)
  은 이제 명시적 에러. 공개 API 시그니처 (`pay()`, relay payload shape)는 변경 없음
- `__tests__/sdk-amount.test.ts` 14 케이스로 회귀 방지 (정확도 5 + 검증 9)

**[P1] `/api/relay`에서 레거시 `paymentId` 필드 제거 (커밋 `749aec4`)**
- v1.3+ SDK는 `nonce` (uint256 string)만 사용 — 수 개월간 활성 호출자 없음
- 서버의 조용한 `paymentId → keccak-truncate` fallback을 명시적 400 거절로 교체
  (`"paymentId is deprecated — upgrade SDK (v1.3+) to use nonce"`)
- `__tests__/relay-body-shape.test.ts`에 2개 assertion 추가로 fallback 부활 차단

**[P1] Next.js 14.2 → 16.2 업그레이드 + React 18 → 19 (커밋 `e88880e`, `5c5a7c7`)**
- `next` 14.2.35 → 16.2.4, `react` / `react-dom` 18 → 19
- React 19 규칙 대응: `Spinner`를 `DepositModal` 스코프 밖으로 호이스트
  (`no-component-definition-in-render`), payment flow에서 `useEffect` setState 캐스케이드를 파생 상태로 리팩터
  (`set-state-in-effect`)
- 내부 라우트 prefetch를 위한 `<a>` → `next/link` 교체 (dashboard / Navbar / docs / grant)
- `tsconfig.json` Next 16 자동 rewrite (`jsx: "react-jsx"`, `.next/dev/types/**/*.ts`)
- 빌드를 `next build --webpack`에 고정 (Turbopack build가 일부 API route에서 `PageNotFoundError`
  던지는 이슈 — dev는 Turbopack 유지)
- `opengraph-image.tsx` runtime을 `edge` → `nodejs`로 변경: Next 16 / React 19 번들이 Vercel의
  Edge Function 1 MB 한도를 초과 (1.06 MB)했고, OG 이미지 생성은 지연 민감도가 없음

**[P2] ESLint 파이프라인 복구 + 22개 잠재 위반 정리 (커밋 `103773a`)**
- Next 16이 `next lint`를 제거 → `lint` 스크립트를 `eslint .`로 전환
- `.eslintrc.json` (legacy) → `eslint.config.mjs` (flat config, ESLint 9 요구사항) 마이그레이션
- ESLint 10은 `eslint-plugin-react`가 의존하는 `context.getFilename()`을 제거했기에 ESLint 9에 고정
  (`eslint-config-next@16`의 peer 범위)
- `argsIgnorePattern: "^_"` + `varsIgnorePattern: "^_"`로 의도적 미사용 파라미터 관용
- 22개 latent warning 해소 (미사용 변수, deprecated 패턴) — 린트 출력은 이제 0 issue
- `npm audit`의 picomatch 취약점도 dev-only로 조정

**[P3] Vercel KV — 유지**
- `@vercel/kv`의 deprecation 경고는 있으나 현재 플랫폼에서 정상 동작. 프로덕션에서 며칠간
  운영 중이므로 즉시 마이그레이션 필요성 없음. 로드맵으로만 기록 (아래 "남은 작업" 참조)

커밋 순서: `e88880e` Next 16 업그레이드 → `5c5a7c7` OG runtime fix → `103773a` lint 복구 →
`749aec4` paymentId 거절 → `85c8851` SDK 금액 정밀도. 총 138/138 테스트 통과, webpack build clean.

### v1.14 (2026-04-17)

> **⚠ 아래는 v1.14 시점의 기록입니다.** `PaymentWitness`, `paymentId` 등은 v1.14에서 제거된 과거 용어이며 현재 코드에 없습니다.

#### 5개 체인 통합 — TransferAuthorization 단일 witness + user-EOA verifyingContract

배포된 Q402PaymentImplementation 컨트랙트를 직접 읽어 확인한 결과, avax/bnb/eth/xlayer/stable 5개 체인이
모두 동일한 witness 타입 `TransferAuthorization(owner, facilitator, token, recipient, amount, nonce, deadline)`과
동일한 `_domainSeparator() → address(this)` 스킴을 사용한다. EIP-7702 위임 컨텍스트에서 `address(this)`는
유저의 EOA로 resolve되므로, 모든 체인의 `verifyingContract`는 유저 EOA다.

이전 문서/SDK/테스트는 avax/bnb/eth가 별개 `PaymentWitness` 타입에 `verifyingContract = impl`을 쓴다고
주장했지만 — 그 경로는 배포된 컨트랙트에 존재하지 않는다. v1.14에서 이 배포 현실에 맞춰 전 코드베이스 정렬.

**[P0] `public/q402-sdk.js` 통합**
- `Q402_WITNESS_TYPES` / `Q402_XLAYER_TRANSFER_TYPES` / `Q402_STABLE_TRANSFER_TYPES` 세 개 타입 정의 제거
- 단일 `Q402_TRANSFER_AUTH_TYPES` 로 교체 (5개 체인 공용)
- 모든 체인의 `verifyingContract`를 `owner` (유저 EOA)로 고정, 체인별 `domainName`만 다르게 적용
- `_payEIP7702()` / `_payStableEIP7702()` / `_payXLayerEIP7702()` 내부 도메인 + witness 전부 통합

**[P0] `contracts.manifest.json` 정정**
- avax/bnb/eth/stable의 `witness.verifyingContractRule`을 `implContract` → `userEOA`로 수정
- 각 체인에 `domainName` 명시 (`Q402 Avalanche` / `Q402 BNB Chain` / `Q402 Ethereum` / `Q402 X Layer` / `Q402 Stable`)
- 매니페스트 노트에 "verifyingContract = user's own EOA under EIP-7702 delegation" 명시

**[P0] `__tests__/contracts-manifest.test.ts` 강화**
- 5개 체인 전수에 `witness.type === "TransferAuthorization"` + `verifyingContractRule === "userEOA"` 검증 추가
- 체인별 `domainName`이 SDK 소스에 embedding 돼 있는지 확인
- 과거 `PaymentWitness` / `Q402_WITNESS_TYPES` 키워드가 SDK에 남아있으면 실패하는 네거티브 테스트 추가
- 112/112 테스트 통과 (`tsc --noEmit` clean)

**[P1] `app/docs/page.tsx` EIP-712 섹션 재작성**
- 체인별 분리 스펙 제거 → 5개 체인 공용 단일 스펙으로 통합
- 서명 예제의 `verifyingContract`를 `userAddress` 고정

**[P1] `scripts/` 전면 교체**
- 삭제: `test-bnb-eip7702.mjs` / `test-eth-eip7702.mjs` / `test-xlayer-eip7702.mjs` / `test-relay.mjs` (모두 구 PaymentWitness + 구 X Layer impl 주소 사용)
- 신규: `scripts/test-eip7702.mjs` — `--chain <key>` CLI 인자 하나로 5개 체인 모두 커버
  - 정정된 X Layer impl `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` (구 `0x31E9D105...` 아님)
  - 정정된 Stable RPC `https://rpc.stable.xyz` + USDT0 토큰 `0x779ded0c9e1022225f8e0630b35a9b54be713736` (18 dec)
- 재작성: `scripts/agent-example.mjs` — `isXLayer` 분기 제거, 통합 TransferAuthorization 스킴 + 올바른 Stable 주소

**[P2] `app/lib/relayer.ts` 주석 정정**
- 런타임 코드는 이미 8-param `transferWithAuthorization` + facilitator/nonce 전달로 올바름 (수정 없음)
- 과거 PaymentWitness를 가리키던 주석만 TransferAuthorization을 기술하도록 정정

**감사 노트 — "그대로 둠"**
- `authorizationGuard` (서버가 chainId + impl 주소 일치 검증) — 이미 제대로 작동, 변경 없음
- X Layer의 `xlayerNonce` 별도 필드 — 레거시 API 호환성을 위해 유지 (서버가 `nonce`와 동일 의미로 처리)

커밋: `6cbb406 unify all 5 chains on single TransferAuthorization + user-EOA verifyingContract`

### v1.13 (2026-04-16)

#### 전체 감사 기반 하드닝 — Tier 정합성 + 레이어별 원자성 + 보안 모델 문서화

**[P1] Credit Tier UI ↔ 서버 정합성 복구**
- `app/payment/page.tsx` VOLUMES 수정
  - `{ label: "100K~500K", value: 300_000, basePrice: 1999 }` → `{ label: "500,000", value: 500_000, basePrice: 1999 }`
  - `{ label: "500K+", value: 500_000, basePrice: 0 }` → `{ label: "500K+", value: 1_000_000, basePrice: 0 }`
  - `calcPrice` 내부 Enterprise 게이트를 `basePrice === 0` 단일 조건으로 단순화
  - UI 임계값 `>= 500_000` → `>= 1_000_000`로 이동 (서버 `TIER_CREDITS[6] = 500_000` 유지)
- Why: 서버는 $1999 결제 시 500K 크레딧을 지급하지만 UI는 "100K~500K" 레인지로 표시되어 불일치 — 서버 지급량을 기준으로 UI 정렬

**[P2] Relay 일일 캡 환불 — 크레딧 언더플로우 시 원자성 보장**
- `app/api/relay/route.ts`
  - `decrementCredit()`가 실패하면 이미 차감된 `dailyCapCharged` 카운터를 `refundRateLimit(dailyCapKey, "daily", 86400)`로 복구
  - 잔액 없는 요청이 경쟁 조건으로 하루 캡을 잠식하던 경로 차단
- Why: 크레딧 경쟁 조건으로 인한 캡 선소진 → 정당한 유저의 요청이 조기에 429

**[P2] Admin Keys Generate — 안전한 로테이션 순서**
- `app/api/keys/generate/route.ts`
  - 기존: 구 키 deactivate → 신 키 발급 → subscription 업데이트 (구 키 실패 시 잠금)
  - 수정: 신 키 발급 → subscription 업데이트 → 구 키 deactivate (fire-and-forget)
  - 공개 rotate 엔드포인트(`app/lib/db.ts` `rotateApiKey`)와 동일한 순서로 통일
- Why: "dangling-active > lockout" — 순서 역전으로 인한 잠금 사고 방지

**[P2] Grant Applications — RPUSH 기반 레이스 제거**
- `app/api/grant/route.ts`
  - POST: `kv.get + kv.set` read-modify-write → `kv.rpush("grant_applications", application)` (atomic)
  - GET: `kv.lrange("grant_applications", 0, -1)`로 읽기, 구버전 JSON 배열 데이터 fallback 유지
  - catch 블록에서 legacy `kv.get/kv.set` 경로 보존 — 무중단 마이그레이션
- Why: 동시 제출 시 last-write-wins로 신청서 유실되는 경로 차단

**[P3] Gas Tank Verify-Deposit — 보안 모델 명시**
- `app/api/gas-tank/verify-deposit/route.ts`
  - POST 핸들러 상단에 보안 모델 주석 추가:
    - 서명 미요구 설계 근거 (addGasDeposit이 SADD txHash로 dedupe, 실제 온체인 TX만 기록)
    - 공격자가 타 주소로 호출해도 그 유저의 실제 입금만 반영되므로 권한 상승/위조 없음
    - Rate limit 5/60s fail-closed가 public RPC 남용 방지

**[P3] Payment Intent Route 정리**
- `app/api/payment/intent/route.ts`
  - `planChain` 주석: "display/reference용" → "plan/credit thresholds 결정; 생략 시 chain으로 fallback"
  - 에러 메시지 `Unsupported plan chain: ${chain}` → `${planChainResolved}` (실제 검증된 값 반영)
- Why: planChain 분리 이후에도 남아있던 레거시 문언 정정

**[P3] Payment Security Copy 업데이트**
- `app/payment/page.tsx`
  - "Pay in USDC / USDT on BNB or Ethereum" → "Pay in USDC / USDT on BNB Chain or Ethereum — credits apply to your selected plan chain (BNB · AVAX · ETH · X Layer · Stable)"
- Why: intent/activate가 planChain과 payment chain을 분리한 새 모델을 유저에게 설명

**감사에서 "그대로 둠" 결정**
- cron `api/cron/gas-alert` 내부 fetch self-call — 실행 비용 무시 가능, 호출자 인증 분리 유지
- `rateLimit` fail-open 기본값 — KV 장애 시에도 핵심 결제 경로 유지, 관리자/결제 엔드포인트만 fail-closed로 명시
- `verify-deposit` 서명 미요구 — 위 P3에 근거 명시

### v1.12 (2026-04-15)

#### P0 보안 강화 — Nonce 기반 인증 + Sandbox-Only 프로비저닝 + Payment Intent

**[P0] Nonce 기반 EIP-191 인증 시스템 (전 엔드포인트)**
- `app/lib/auth.ts` 신규 — 서버사이드 nonce 코어
  - `createOrGetNonce(addr)` — `auth_nonce:{addr}` KV에 1시간 TTL로 저장, 멱등적 (`NONCE_TTL_SEC = 60 * 60`)
  - `verifyNonceSignature(addr, nonce, sig)` — 서명 메시지: `"Q402 Auth\nAddress: {addr}\nNonce: {nonce}"`
  - `invalidateNonce(addr)` — 키 로테이션 후 강제 재서명 유도
  - `requireAuth(address, nonce, signature)` — 모든 보호 라우트에서 공유하는 헬퍼
- `app/lib/auth-client.ts` 신규 — 클라이언트 nonce 캐시
  - `getAuthCreds(addr, signFn)` — sessionStorage 55분 캐시 (`CLIENT_NONCE_TTL_MS`), 서버 1h보다 5분 일찍 만료 → race 방지, 지갑 팝업 1회/세션
  - `clearAuthCache(addr)` — NONCE_EXPIRED 수신 시 호출
- `app/api/auth/nonce/route.ts` 신규 — `GET /api/auth/nonce?address=0x...`
  - 20 req/60s rate limit, fail-closed

**[P0] 신규 계정 Sandbox Key만 발급 (live key는 결제 후 activate에서만 발급)**
- `app/api/keys/provision/route.ts` 리팩터
  - 기존 정적 서명 (`Q402 API Key Request\nAddress: {addr}`) → `requireAuth()` 교체
  - 신규 계정: `apiKey: null`, `sandboxApiKey: "q402_test_..."`, `hasPaid: false`
  - 기존 유료 계정: live key 정상 반환

**[P1] Payment Intent — 결제 전 체인+금액 바인딩**
- `app/api/payment/intent/route.ts` 신규 — `POST /api/payment/intent`
  - body: `{address, nonce, signature, chain, expectedUSD}`
  - KV에 2시간 TTL로 intent 저장 (`payment_intent:{addr}`)
- `app/api/payment/activate/route.ts` 업데이트
  - intent 없으면 402 (`NO_INTENT` 코드)
  - 발견된 TX의 체인이 intent와 다르면 402 (`CHAIN_MISMATCH`)
  - 결제 금액이 intent의 95% 미만이면 402 (`AMOUNT_LOW`)
  - `clearPaymentIntent(addr)` — 활성화 성공 후 intent 삭제 (재사용 방지)
- `app/lib/blockchain.ts` — `checkPaymentOnChain(from, intentChain?)` optional chain filter 추가

**나머지 서버 라우트 nonce 인증 마이그레이션:**
- `app/api/keys/rotate/route.ts` — `requireAuth()` + 로테이션 후 `invalidateNonce(addr)`
- `app/api/transactions/route.ts` — GET 파라미터에 `nonce` 추가
- `app/api/webhook/route.ts` (GET/POST/DELETE) — GET은 쿼리파라미터 nonce, POST/DELETE는 body
- `app/api/webhook/test/route.ts` — `requireAuth()` 교체

**프론트엔드 (dashboard, payment)**
- `app/dashboard/page.tsx` — `q402_sig_*` sessionStorage 패턴 → `getAuthCreds()` 전면 교체
  - provision, transactions, webhook GET, rotateKey, saveWebhook, testWebhook 모두 업데이트
  - 401 NONCE_EXPIRED 수신 시 `clearAuthCache()` → 다음 로드에서 자동 재서명
  - `apiKey: null` 응답 처리 (미결제 계정은 live key 표시 안 함)
- `app/payment/page.tsx` — `getAuthCreds()` 교체 + activate 전 intent POST 추가

### v1.11 (2026-04-15)

#### Codex 2차 감사 수정
- **Fix [P2]**: `/api/inquiry` KV 저장 방식 변경 — `get→set` array 패턴 → Redis `rpush/lrange` (동시 요청 시 last-write-wins 유실 방지)
- **Docs [P1]**: `docs/page.tsx` Quick Start 코드 수정
  - `Q402.sign()` (존재하지 않던 메서드) → `new Q402Client({apiKey, chain}).pay({to, amount, token})`
  - amount 형식: atomic units `"50000000"` → human-readable `"50.00"`
  - 2-step flow(sign + backend relay) → SDK가 모두 처리하는 단일 `pay()` 호출로 통일
- **Docs [P1]**: EIP-712 Witness 타입 체인별 분리 명시
  - avax/bnb/eth: `PaymentWitness` (6 fields: owner, token, amount, to, deadline, paymentId)
  - xlayer/stable: `TransferAuthorization` (7 fields: owner, facilitator, token, recipient, amount, nonce, deadline)
- **Docs**: 버전 배지 `v1.7.0 → v1.10`, 에러코드 `QUOTA_EXCEEDED` 설명 TX credits 모델로 수정, Gas Pool alert email → Telegram

### v1.10 (2026-04-15)

#### 보안 감사 수정 (Codex audit 반영)
- **Security [P0]**: 무료 provision 계정 `paidAt` 빈 문자열로 변경 — `isSubscriptionActive()` 오남용 차단
  - `relay/route.ts`: 만료 체크를 `amountUSD > 0 && paidAt` 유료 계정에만 적용, sandbox 스킵
  - `payment/check/route.ts`: 무료 계정을 `not_found` 처리 (결제 페이지 유도)
  - `db.ts`: `isSubscriptionActive()` / `getSubscriptionExpiry()` 빈 paidAt 방어 추가
- **Security [P1]**: Rate limit `failOpen` 파라미터 추가 — `/api/relay`, `/api/gas-tank/verify-deposit` fail-closed로 변경 (KV 장애 시 차단)
- **Fix [P1]**: Gas Tank 출금 `tx.wait(1)` 추가 — receipt 1 confirmation 확인 후 잔고 차감 (dropped TX 방지)
- **Fix [P2]**: Dashboard `PLAN_QUOTA` starter `1_000 → 500` 수정, 누락 플랜(basic/pro/scale/business/enterprise_flex) 추가
- **Fix [P3]**: `/api/gas-tank/verify-deposit` `newDeposits` 카운트 수정 — `addGasDeposit()` 반환값으로 중복 TX 제외

### v1.9 (2026-04-13)

#### 결제 모델 개편
- **Refactor**: TX 크레딧 모델 도입 — 매 결제마다 +30일 연장 + TX 건수 추가 (플랜 등급 첫 결제 시 고정)
- **Refactor**: `blockchain.ts` — `txQuotaFromAmount(usd, chain)` 추가, 체인별 가격 임계값 반영
- **Refactor**: `activate/route.ts` — first/additional 분기 제거, 단일 로직으로 통합
- **Refactor**: `relay/route.ts` — 월간 quota 체크 → `quotaBonus > 0` 크레딧 체크, 성공 시 크레딧 1 차감
- **Fix**: Payment 페이지 자동 redirect 제거 — 기존 구독자도 추가 결제 가능
- **UI**: Payment 페이지 copy 업데이트 — "+30 days · N TXs per payment"

#### 체인별 가격 검증 강화
- **Fix**: `planFromAmount()` / `txQuotaFromAmount()` 에 체인 파라미터 추가
  - BNB/XLayer/Stable 1.0×, AVAX 1.1×, ETH 1.5× 적용
  - ETH $30 결제 → BNB 기준($30) 통과했던 버그 수정 (ETH 임계값 $39 적용)

#### 보안 감사 수정 (2026-04-13)
- **Security**: `TEST_MODE` 환경변수 완전 제거 — `.env.local` + Vercel production 환경에서 삭제, `planFromAmount()` 우회 코드 제거
- **Security**: Admin 엔드포인트 Rate Limit 추가 — `GET /api/grant`, `GET /api/inquiry`, `POST /api/gas-tank/withdraw` 모두 IP당 5 req/60s 적용 (admin secret 검증 전)
- **Fix**: `/api/gas-tank/user-balance` 파라미터 변경 — `?apiKey=` → `?address=` (API 키 URL 노출 차단, Gas Tank $0 버그 수정)

### v1.8 (2026-04-13)

#### 보안 수정
- **Security**: `TEST_MODE` 백도어 완전 제거 — `planFromAmount()` 에서 $1 → starter 우회 차단
- **Security**: Sandbox 키 감지 로직 수정 — key prefix(`q402_test_`) 신뢰 제거, KV `isSandbox` 플래그만 사용
- **Security**: 결제 TX 재사용 방지 — `used_txhash:{hash}` KV 플래그(90일 TTL)로 동일 TX 재활성화 차단
- **Security**: Webhook SSRF 강화 — IPv6 loopback(`::1`, `::ffff:`), GCP/AWS/Azure 메타데이터 엔드포인트 차단 추가
- **Security**: `/api/relay` per-API-key rate limit 추가 — 30 req/60s (기존 IP 기준에 추가)

#### UX / 버그 수정
- **Fix**: 지갑 연결이 페이지 이동 시 끊기는 버그 수정 — `getConnectedAccount()` null 반환 시 localStorage 초기화 제거
- **Fix**: My Page 페이월 Activate 버튼 — `<a href>` → `router.push()` (Next.js 클라이언트 내비게이션)
- **Feature**: My Page 구독 만료 경고 배너 — 만료 7일 전 노란 배너, 만료 후 빨간 배너 + Renew 버튼
- **Fix**: Pricing 페이지 가격 payment page 기준으로 통일 ($30/$150/$800 BNB 기준), Starter "BNB Chain only" → "All 5 EVM chains"
- **Fix**: Relay TX 기록 fire-and-forget — KV write 실패가 성공 응답 blocking 하던 버그 수정

#### Grant 프로그램
- **Feature**: `/grant` 페이지 — Seed/$500, Builder/$2K, Ecosystem 3단계 그랜트 티어
- **Feature**: Grant 신청 폼 → Vercel KV 저장 + Telegram `@kwanyeonglee` 알림
- **Feature**: Why build with Q402 섹션 — 01/02/03 넘버링, 기술적 강점 중심 copy
- **Feature**: Navbar Grant 링크 추가

### v1.7 (2026-04-11)
- **Feature**: Terms of Service (`/terms`) + Privacy Policy (`/privacy`) 페이지 추가
- **Feature**: Footer에 Terms / Privacy 링크 추가
- **Feature**: Gas Tank 저잔고 Telegram 알림 시스템 (`/api/gas-tank?check_alerts=1`)
- **Feature**: Vercel Cron 매일 09:00 UTC 자동 알림 (`vercel.json`)
- **Feature**: `TEST_MODE=true` 환경변수 — $1+ 결제를 starter 플랜으로 매핑 (E2E 테스트용) ⚠️ v1.9에서 완전 제거됨
- **Feature**: `scripts/test-api.mjs` — API Key 유효성, Gas Tank, Sandbox Relay, 보안 체크 자동화
- **Fix**: `checkPaymentOnChain` BNB RPC fallback 5개 추가 (`bsc.publicnode.com` rate limit 우회)
- **Fix**: `anyQuerySucceeded` 플래그 — 모든 토큰 쿼리 실패 시 다음 RPC로 fallback
- **Fix**: BNB blockWindow 2000 → 8000 (~7시간 범위)
- **Fix**: `TEST_MODE` 값 trailing newline trim (`"true\n"` → `.trim() === "true"`)
- **Fix**: Sandbox key가 relay route subscription 체크 통과 못하는 버그 수정
- **Fix**: Gas Tank UI — 5개 체인 그리드 (`xl:grid-cols-5`), `Pool:` 라인 제거, 잔고 0 시 "Deposit" 버튼으로 표시
- **E2E 검증**: 1 USDT BNB Chain → API Key 발급 → My Page → Sandbox Relay 전체 플로우 성공

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
