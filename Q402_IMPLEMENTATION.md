# Q402 — 전체 구현 문서

> 작성일: 2026-03-10 / **최종 업데이트: 2026-04-08 (v1.3)**
> 프로젝트 경로: `C:/Users/user/q402-landing/`
> 기술 스택: Next.js 14 App Router · TypeScript · ethers.js v6 · viem · Tailwind CSS · framer-motion

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [디렉터리 구조](#2-디렉터리-구조)
3. [데이터베이스 구조 (Vercel KV)](#3-데이터베이스-구조)
4. [프론트엔드 — 지갑 연결](#4-프론트엔드--지갑-연결)
5. [구독 & API Key 관리](#5-구독--api-key-관리)
6. [Direct Inquiry 시스템](#6-direct-inquiry-시스템)
7. [Gas Tank — 릴레이어 잔고](#7-gas-tank--릴레이어-잔고)
8. [Gas Tank — 유저 입금 잔고](#8-gas-tank--유저-입금-잔고)
9. [EIP-7702 릴레이 트랜잭션](#9-eip-7702-릴레이-트랜잭션)
10. [클라이언트 SDK (q402-sdk.js)](#10-클라이언트-sdk)
11. [대시보드 페이지](#11-대시보드-페이지)
12. [v1.4 신규 기능 — Sandbox / Webhook / Key Rotation / Gas Fix](#12-v14-신규-기능-2026-04-08)
13. [미완성 / 다음 단계](#12-미완성--다음-단계)
14. [환경 변수](#13-환경-변수)
14. [체인별 컨트랙트 현황](#14-체인별-컨트랙트-현황)
15. [보안 패치 이력 (v1.2)](#15-보안-패치-이력-v12)

---

## 1. 프로젝트 개요

Q402는 **가스리스(Gasless) ERC-20 결제 인프라**이다. 외부 개발팀(클라이언트)이 Q402 API를 호출하면, 릴레이어(Q402 서버)가 가스를 대납해서 사용자는 gas 없이 USDC/USDT를 전송할 수 있다.

### 핵심 플로우 요약

**EIP-7702 방식 (avax / bnb / eth)**
```
[클라이언트 앱]
  └─ 유저가 "Pay USDC" 버튼 클릭
      └─ SDK가 EIP-712 witnessSig + EIP-7702 authorization 서명 생성
          └─ POST /api/relay { witnessSig, authorization }
              └─ 릴레이어가 Type 4 TX 전송 (gas 대납)
                  └─ Q402PaymentImplementation.pay() 실행
                      └─ 유저 EOA → 수신자로 USDC 이동
```

**EIP-7702 방식 (xlayer) — 2026-03-12 확인**
```
[클라이언트 앱]
  └─ 유저가 "Pay USDC" 버튼 클릭
      └─ SDK가 GET /api/relay/info → facilitator 주소 조회
          └─ EIP-712 TransferAuthorization 서명 + EIP-7702 authorization 서명 (2 sigs)
              └─ POST /api/relay { witnessSig, authorization, xlayerNonce }
                  └─ 릴레이어(facilitator)가 Type 4 TX 전송 (OKB 가스 대납)
                      └─ Q402PaymentImplementationXLayer.transferWithAuthorization() 실행
                          └─ 유저 EOA → 수신자로 USDC 이동
```

> X Layer는 EIP-7702 Type 4 TX를 지원한다 (2026-03-12 테스트 확인).
> 단, witness 타입이 avax/bnb/eth와 다름 (`TransferAuthorization`, verifyingContract = 유저 EOA).
> EIP-3009 방식도 fallback으로 유지됨 (eip3009Nonce 전달 시 자동 선택).

---

## 2. 디렉터리 구조

```
q402-landing/
├── app/
│   ├── api/
│   │   ├── payment/
│   │   │   ├── check/route.ts          # GET  — 구독 상태 확인
│   │   │   └── activate/route.ts       # POST — 온체인 결제 스캔 + API Key 자동 발급 (v1.3 복원)
│   │   ├── keys/
│   │   │   ├── generate/route.ts       # POST — API Key 재발급 (Admin 전용)
│   │   │   ├── verify/route.ts         # POST — API Key 유효성 검증
│   │   │   ├── topup/route.ts          # POST — 할당량 보너스 추가 (Admin 전용)
│   │   │   └── provision/route.ts      # POST — 구독 수동 생성 (Admin 전용)
│   │   ├── gas-tank/
│   │   │   ├── route.ts                # GET  — 릴레이어 온체인 잔고 (전체)
│   │   │   ├── verify-deposit/route.ts # POST — 유저 입금 스캔 후 DB 기록
│   │   │   ├── user-balance/route.ts   # GET  — 유저 입금 잔고 조회 (apiKey 필요)
│   │   │   └── withdraw/route.ts       # POST — 가스 잔고 출금 (Admin 전용)
│   │   ├── wallet-balance/route.ts     # GET  — 유저 지갑 잔고 (4체인)
│   │   ├── inquiry/route.ts            # POST — 프로젝트 문의 저장 / GET — 문의 목록 (Admin)
│   │   ├── transactions/route.ts       # GET  — 릴레이 TX 이력 (apiKey 필요)
│   │   └── relay/
│   │       ├── route.ts                # POST — EIP-7702 / EIP-3009 릴레이 TX 제출
│   │       └── info/route.ts           # GET  — facilitator 주소 반환 (SDK용)
│   ├── lib/
│   │   ├── db.ts                       # Vercel KV CRUD 헬퍼
│   │   ├── blockchain.ts               # ERC-20 Transfer 이벤트 스캔
│   │   ├── relayer.ts                  # viem EIP-7702 settlePayment() / settlePaymentXLayerEIP7702() / settlePaymentEIP3009()
│   │   ├── access.ts                   # isPaid (v1.1: 항상 true) / MASTER_ADDRESSES
│   │   └── wallet.ts                   # connectWallet / getConnectedAccount
│   ├── context/
│   │   └── WalletContext.tsx           # 전역 지갑 상태 (localStorage 즉시 복원)
│   ├── components/
│   │   ├── WalletButton.tsx            # 지갑 연결 모달
│   │   ├── Navbar.tsx
│   │   ├── Hero.tsx
│   │   ├── HowItWorks.tsx
│   │   ├── Pricing.tsx
│   │   ├── Contact.tsx
│   │   └── Footer.tsx
│   ├── dashboard/page.tsx              # 대시보드 (4개 탭)
│   ├── payment/page.tsx                # 4단계 온체인 결제 (체인→볼륨→지갑→송금+검증)
│   ├── docs/page.tsx                   # 개발자 문서
│   └── page.tsx                        # 랜딩 메인
├── public/
│   ├── q402-sdk.js                     # 클라이언트 SDK v1.2.0 (배포용)
│   ├── bnb.png / eth.png / avax.png / xlayer.png
│   └── arbitrum.png / scroll.png
└── .env.local                          # RELAYER_PRIVATE_KEY, KV_REST_API_*, ADMIN_SECRET
```

> ⚠️ v1.0의 `data/db.json` (JSON 파일 DB)는 v1.1에서 **Vercel KV (Redis)** 로 마이그레이션됨.

---

## 3. 데이터베이스 구조

**v1.1부터 Vercel KV (Redis)를 사용한다.** (`app/lib/db.ts`)

```
kv.get("subscriptions:{address}")  → SubscriptionRecord
kv.get("apikeys:{apiKey}")         → ApiKeyRecord
kv.get("gasdeposits:{address}")    → GasDeposit[]
kv.get("relayedtxs:{address}")     → RelayedTx[]
kv.get("inquiries")                → Inquiry[]
```

### 데이터 구조 예시

**SubscriptionRecord**
```json
{
  "address": "0xOwnerAddress",
  "paidAt":  "2026-03-19T00:00:00.000Z",
  "apiKey":  "q402_live_xxx",
  "plan":    "growth",
  "txHash":  "0xOnChainPaymentTxHash",
  "amountUSD": 150
}
```

**ApiKeyRecord**
```json
{
  "address":   "0xOwnerAddress",
  "createdAt": "2026-03-19T00:00:00.000Z",
  "active":    true,
  "plan":      "growth"
}
```

**Inquiry**
```json
{
  "id":             "inq_1710834000000_abc12",
  "appName":        "MyDApp",
  "website":        "https://mydapp.io",
  "email":          "dev@mydapp.io",
  "telegram":       "@myhandle",
  "category":       "DeFi",
  "targetChain":    "avax",
  "expectedVolume": "1000-5000",
  "description":    "We need gasless USDC transfers for...",
  "submittedAt":    "2026-03-19T10:00:00.000Z"
}
```

### DB 헬퍼 함수 (`app/lib/db.ts`)

| 함수 | 역할 |
|------|------|
| `getSubscription(address)` | 구독 조회 |
| `setSubscription(address, data)` | 구독 저장/갱신 |
| `getApiKeyRecord(apiKey)` | API Key → 레코드 조회 |
| `generateApiKey(address, plan)` | 새 API Key 생성 후 저장 |
| `deactivateApiKey(apiKey)` | API Key 비활성화 (키 교체 시 구 키 무효화) |
| `getGasDeposits(address)` | 유저의 입금 내역 목록 |
| `addGasDeposit(address, deposit)` | 입금 추가 (txHash 중복 방지) |
| `getGasBalance(address)` | 입금합계 - 소비합계 = 현재 잔고 |
| `recordRelayedTx(address, tx)` | 릴레이 TX 기록 (가스 소비 추적) |

---

## 4. 프론트엔드 — 지갑 연결

### WalletContext (`app/context/WalletContext.tsx`)

- `address` 상태를 전역으로 관리
- 초기 마운트 시 `localStorage["q402_wallet"]`에서 즉시 읽어 페이지 새로고침 시 튕김 방지
- MetaMask(`window.ethereum`) + OKX Wallet(`window.okxwallet`) 둘 다 지원

### WalletButton (`app/components/WalletButton.tsx`)

- 미연결: "Connect Wallet" 버튼
- 연결됨: `MY PAGE` 버튼 (sparkle 반짝 애니메이션) → `/dashboard`로 이동

### 결제 게이팅 (`app/lib/access.ts`)

**v1.1: 결제 게이팅 임시 제거. `isPaid()` 항상 `true` 반환.**

```typescript
const MASTER_ADDRESSES = [
  "0xfc77ff29178b7286a8ba703d7a70895ca74ff466",
  "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28",
];

// v1.1: 항상 true 반환 (페이월 임시 제거)
isPaid(address)  // always true
setPaid(address) // no-op (localStorage 저장 유지)
```

> 결제 플로우 복원 시 이 함수들만 원래 로직으로 되돌리면 됨.

---

## 5. 구독 & API Key 관리

### 구독 수동 생성 (Admin)

**`POST /api/keys/provision`** — header: `x-admin-secret`

Inquiry 검토 후 관리자가 수동으로 구독을 생성하고 API Key를 발급한다.

```json
// 요청
{ "address": "0xClientAddress", "plan": "growth" }

// 응답
{ "success": true, "apiKey": "q402_live_xxx", "plan": "growth" }
```

### API Key 재발급 (Admin)

**`POST /api/keys/generate`** — header: `x-admin-secret`

기존 키를 `deactivateApiKey()`로 비활성화하고 새 키 발급.

```json
{ "address": "0xClientAddress" }
```

### API Key 검증

**`POST /api/keys/verify`** — body: `{ apiKey }`

구독 만료 여부와 현재 키 일치 여부도 함께 확인한다.

```json
// 응답 (유효)
{
  "valid": true,
  "address": "0xOwnerAddress",
  "plan": "growth",
  "createdAt": "2026-03-19T00:00:00.000Z",
  "expired": false,
  "expiresAt": "2026-04-19T00:00:00.000Z"
}

// 응답 (만료)
{ "valid": false, "reason": "expired" }

// 응답 (키 교체됨)
{ "valid": false, "reason": "rotated" }
```

### 할당량 보너스 추가 (Admin)

**`POST /api/keys/topup`** — header: `x-admin-secret`

```json
{ "address": "0xClientAddress", "bonus": 5000 }
```

### PLAN_QUOTA 매핑

| 플랜 | TX/월 |
|------|-------|
| Starter | 500 |
| Basic | 1,000 |
| Growth | 10,000 |
| Pro | 10,000 |
| Scale | 100,000 |
| Business | 100,000 |
| Enterprise / Enterprise Flex | 500,000 |

---

## 6. Direct Inquiry 시스템

v1.1에서 온체인 결제 플로우를 대체하는 문의 시스템.

### 플로우

```
유저가 /payment 방문
  └─ Quote Builder에서 체인 + 예상 볼륨 + 토큰 선택
      └─ "Get a Quote" 클릭 → InquiryModal 팝업
          └─ 프로젝트 세부사항 입력 (appName, email, chain, volume 등)
              └─ POST /api/inquiry → Vercel KV 저장
                  └─ 팀이 검토 후 수동으로 API Key 발급
```

### Inquiry 제출 API

**`POST /api/inquiry`**

```json
// 요청 (필수: appName, email, category, targetChain, expectedVolume)
{
  "appName":        "MyDApp",
  "website":        "https://mydapp.io",
  "email":          "dev@mydapp.io",
  "telegram":       "@myhandle",
  "category":       "DeFi",
  "targetChain":    "avax",
  "expectedVolume": "1000-5000",
  "description":    "We need gasless USDC transfers..."
}

// 응답
{ "success": true, "id": "inq_1710834000000_abc12" }
```

### Inquiry 목록 조회 (Admin)

**`GET /api/inquiry`** — header: `x-admin-secret`

```json
{
  "inquiries": [ /* Inquiry[] */ ]
}
```

---

## 7. Gas Tank — 릴레이어 잔고

**`GET /api/gas-tank`**

릴레이어 지갑(`0xfc77...`)의 온체인 native token 잔고를 실시간 조회한다.

### 동작

1. 4개 체인에서 동시에 `provider.getBalance(RELAYER)` 호출 (5초 타임아웃)
2. CoinGecko API로 BNB/ETH/AVAX 가격 조회 (60초 캐시)
3. 잔고 × 가격 = USD 환산액 계산

### 응답 예시

```json
{
  "tanks": [
    { "key": "bnb",    "chain": "BNB Chain",  "token": "BNB",  "balance": "1.2340", "usd": "$865.31" },
    { "key": "eth",    "chain": "Ethereum",   "token": "ETH",  "balance": "0.1200", "usd": "$456.00" },
    { "key": "avax",  "chain": "Avalanche",  "token": "AVAX", "balance": "25.4000","usd": "$812.80" },
    { "key": "xlayer","chain": "X Layer",    "token": "OKB",  "balance": "0.0000", "usd": "$0.00"   }
  ]
}
```

> 이 잔고는 **Q402 플랫폼 전체** 릴레이어 잔고이며, 개별 클라이언트의 입금 잔고와 다르다.

### Gas 출금 (Admin)

**`POST /api/gas-tank/withdraw`** — header: `x-admin-secret`

```json
{ "chain": "avax", "to": "0xAddress", "amount": "1.5" }
```

---

## 8. Gas Tank — 유저 입금 잔고

유저가 Gas Tank에 native token(AVAX/BNB/ETH)을 릴레이어 주소로 입금하면, 그만큼 릴레이 비용으로 차감된다.

### 입금 스캔 API

**`POST /api/gas-tank/verify-deposit`** — body: `{ address }`

#### 동작 로직

1. 4개 체인에서 `eth_getBlockByNumber` 배치 RPC 호출 (블록 20개씩)
2. 각 블록의 트랜잭션 중 `from=유저주소, to=릴레이어주소, value≠0x0` 필터
3. 발견된 TX를 `addGasDeposit()` — txHash 중복 방지 처리
4. 현재 잔고(`입금합계 - 소비합계`) 반환

```
BNB/AVAX/XLayer : 최근 200 블록 스캔
Ethereum        : 최근 50 블록 스캔
```

### 유저 잔고 조회 API

**`GET /api/gas-tank/user-balance`** — query: `?apiKey=q402_live_xxx`

> ⚠️ v1.1: `address` 파라미터 → `apiKey` 파라미터로 변경 (주소 열람 방지 보안 강화)

```json
{
  "balances": { "bnb": 0.5, "eth": 0.0, "avax": 2.1, "xlayer": 0.0 },
  "deposits": [
    { "chain": "avax", "token": "AVAX", "amount": 2.1, "txHash": "0x...", "depositedAt": "..." }
  ]
}
```

### 잔고 계산 방식

```
getGasBalance(address) =
  sum(gasDeposits[address].amount)      // 누적 입금
- sum(relayedTxs[address].gasCostNative) // 누적 소비
```

> gasCostNative는 v1.1부터 실제 TX receipt에서 계산됨 (v1.0에서는 항상 0이었음).

---

## 9. 릴레이 트랜잭션 — 체인별 방식

### 9-A. EIP-7702 방식 (avax / bnb / eth)

EIP-7702는 EOA(일반 지갑)가 특정 컨트랙트 코드를 "위임(delegate)"해서 실행하도록 하는 이더리움 표준이다.

```
유저 EOA  ──(EIP-7702 authorization)──▶ Q402PaymentImplementation
                                         .pay() 실행 시 유저 EOA처럼 동작
```

#### 컨트랙트

| 체인 | 주소 | 상태 |
|------|------|------|
| Avalanche | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | ✅ 배포완료 + 테스트 성공 |
| BNB Chain | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | ✅ 배포완료 |
| Ethereum  | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | ✅ 배포완료 |
| X Layer   | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | ✅ EIP-7702 테스트 성공 |
| **Stable** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | ✅ 배포완료 (v1.2) |

#### 릴레이 API 요청 (EIP-7702)

```json
{
  "apiKey":     "q402_live_xxx",
  "chain":      "avax",
  "token":      "USDC",
  "from":       "0xPayer",
  "to":         "0xRecipient",
  "amount":     "5000000",
  "deadline":   1712345678,
  "paymentId":  "0xbytes32hex...",
  "witnessSig": "0xEIP712signature...",
  "authorization": {
    "chainId":  43114,
    "address":  "0xE5b90D564650bdcE7C2Bb4344F777f6582e05699",
    "nonce":    0,
    "yParity":  0,
    "r":        "0x...",
    "s":        "0x..."
  }
}
```

#### settlePayment 내부 (`app/lib/relayer.ts`)

```typescript
// viem으로 Type 4 (EIP-7702) 트랜잭션 전송
const txHash = await walletClient.sendTransaction({
  chain: null,
  to:   params.owner,    // 유저 EOA (impl 코드가 위임됨)
  data: callData,        // Q402PaymentImplementation.pay() calldata
  gas:  BigInt(300000),
  authorizationList: [{ ...params.authorization }],
});
```

---

### 9-B. EIP-7702 방식 (xlayer) — 기본 모드

X Layer도 EIP-7702 Type 4 TX를 지원한다 (2026-03-12 확인).
단, 컨트랙트와 witness 타입이 avax/bnb/eth와 다르다.

```
유저 EOA  ──(EIP-7702 authorization)──▶ Q402PaymentImplementationXLayer
                                          .transferWithAuthorization() 실행 시 유저 EOA처럼 동작
```

#### avax/bnb/eth와의 차이점

| 항목 | avax / bnb / eth | xlayer |
|------|-----------------|--------|
| 컨트랙트 | `Q402PaymentImplementation` | `Q402PaymentImplementationXLayer` |
| 함수 | `pay()` | `transferWithAuthorization()` |
| Witness 타입 | `PaymentWitness` | `TransferAuthorization` |
| `verifyingContract` | implContract 주소 | **유저 EOA** (address(this) under delegation) |
| nonce 타입 | `bytes32` (paymentId) | `uint256` (random, usedNonces mapping) |
| facilitator 체크 | 없음 | `msg.sender == facilitator` 필수 |

#### 컨트랙트

| 체인 | 주소 | EIP-712 NAME |
|------|------|-------------|
| X Layer | `0x31E9D105df96b5294298cFaffB7f106994CD0d0f` | `Q402 X Layer` |

#### 서명 도메인 (유저가 서명)

```javascript
// verifyingContract = 유저의 EOA (avax/bnb/eth와 핵심 차이)
const domain = {
  name:              "Q402 X Layer",
  version:           "1",
  chainId:           196,
  verifyingContract: owner,  // ← 유저 EOA 주소
};

const types = {
  TransferAuthorization: [
    { name: "owner",       type: "address" },
    { name: "facilitator", type: "address" },  // relayer 지갑 주소
    { name: "token",       type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "uint256" },  // random uint256
    { name: "deadline",    type: "uint256" },
  ],
};
```

> SDK는 서명 전에 `GET /api/relay/info`로 facilitator 주소를 자동 조회한다.

#### 릴레이 API 요청 (xlayer EIP-7702)

```json
{
  "apiKey":       "q402_live_xxx",
  "chain":        "xlayer",
  "token":        "USDC",
  "from":         "0xPayer",
  "to":           "0xRecipient",
  "amount":       "50000",
  "deadline":     1712345678,
  "witnessSig":   "0xTransferAuthorizationSignature...",
  "xlayerNonce":  "96532382513669737...",
  "facilitator":  "0xRelayerAddress...",
  "authorization": {
    "chainId":  196,
    "address":  "0x31E9D105df96b5294298cFaffB7f106994CD0d0f",
    "nonce":    0,
    "yParity":  1,
    "r":        "0x...",
    "s":        "0x..."
  }
}
```

#### 검증된 X Layer EIP-7702 테스트 결과 (2026-03-12)

| 항목 | 값 |
|------|---|
| Payer | `0xFe7bA1CDc7077F71855627F9983a70188826726f` |
| Facilitator (Relayer) | `0xfc77FF29178B7286A8bA703D7a70895CA74fF466` |
| Recipient | `0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28` |
| TX Hash | `0xd121c23c6313e2f73751b3735f5a9c934386930ef1ca0ba04578de1bfddfd9a0` |
| Block | 54540550 |
| Payer OKB 사용 | 0 OKB ✅ |
| USDC 이동 | 0.05 USDC ✅ |
| 방식 | Q402PaymentImplementationXLayer.transferWithAuthorization() (EIP-7702 Type 4 TX) |

---

### 9-C. EIP-3009 방식 (xlayer fallback)

`authorization` 없이 `eip3009Nonce`만 전달하면 자동으로 EIP-3009 fallback으로 실행된다.
SDK v1.1.x 이하 하위 호환 유지용.

```json
{
  "apiKey":       "q402_live_xxx",
  "chain":        "xlayer",
  "token":        "USDC",
  "from":         "0xPayer",
  "to":           "0xRecipient",
  "amount":       "50000",
  "deadline":     1712345678,
  "witnessSig":   "0xEIP3009signature(65bytes)...",
  "eip3009Nonce": "0xrandomBytes32..."
}
```

#### 검증된 EIP-3009 테스트 결과 (2026-03-12)

| 항목 | 값 |
|------|---|
| TX Hash | `0xb21a10be318e7893d9246ae49a141c18152040b1ceb68eb3e799b62c953fbc3c` |
| Block | 54523313 |
| USDC 이동 | 0.05 USDC ✅ |
| 방식 | USDC.transferWithAuthorization() 직접 호출 |

---

### 9-D. 처리 단계 (공통, v1.1)

1. **API Key 검증** — `getApiKeyRecord(apiKey)`, `active` 확인
2. **구독 만료 + 키 교체 확인** — `subscription.apiKey !== apiKey` → 401 / 30일 만료 → 403
3. **체인별 추가 필드 검증**
   - xlayer: `authorization + xlayerNonce` → EIP-7702 / `eip3009Nonce` → EIP-3009 fallback
   - avax/bnb/eth: `authorization` 필수
4. **Gas Tank 잔고 확인** — `getGasBalance(keyRecord.address)[chain] > 0.0001`
5. **paymentId 처리** — bytes32 hex면 그대로, 문자열이면 keccak256, 없으면 랜덤 생성
6. **체인 분기** — xlayer EIP-7702 → `settlePaymentXLayerEIP7702()` / xlayer EIP-3009 → `settlePaymentEIP3009()` / 기타 → `settlePayment()`
7. **TX 기록** — `recordRelayedTx()` 호출 (gasCostNative = receipt에서 실제 계산)

### 9-E. 응답

```json
{
  "success":     true,
  "txHash":      "0x...",
  "blockNumber": "54540550",
  "tokenAmount": 0.05,
  "token":       "USDC",
  "chain":       "xlayer",
  "method":      "eip7702_xlayer"
}
```
> method 값: `"eip7702"` (avax/bnb/eth), `"eip7702_xlayer"` (xlayer EIP-7702), `"eip3009"` (xlayer fallback)

---

## 10. 클라이언트 SDK

파일: `public/q402-sdk.js` (v1.2.0)

개발자가 EIP-712 서명 / EIP-7702 authorization 생성 방법을 몰라도 단 3줄로 결제를 구현할 수 있다.

### 사용법 (브라우저)

```html
<script src="https://q402.io/q402-sdk.js"></script>
<script src="https://cdn.ethers.io/lib/ethers-5.7.2.umd.min.js"></script>
```

```javascript
// Avalanche / BNB / ETH (EIP-7702 방식)
const q402 = new Q402Client({
  apiKey: "q402_live_xxxxx",
  chain:  "avax",           // "avax" | "bnb" | "eth" | "xlayer"
  // relayUrl: "http://localhost:3000/api/relay"  // 개발 시 오버라이드
});

// X Layer (EIP-7702 방식 — 자동 감지, 추가 설정 불필요)
const q402xl = new Q402Client({ apiKey: "q402_live_xxxxx", chain: "xlayer" });

// 결제
const result = await q402.pay({
  to:     "0xRecipient...",
  amount: "5.00",    // 사람이 읽을 수 있는 형태 (USDC 5달러)
  token:  "USDC",
  // paymentId: "order-12345"  // 선택사항 (없으면 자동 생성)
});

console.log(result.txHash); // 온체인 TX 해시
```

### SDK 내부 동작

**EIP-7702 체인 (avax / bnb / eth)**
```
q402.pay() 호출
  ├─ 1. EIP-712 witnessSig 서명
  │      domain: Q402PaymentImplementation / v1 / chainId / implContract
  │      types:  PaymentWitness { owner, token, amount, to, deadline, paymentId }
  │
  ├─ 2. EIP-7702 authorization 서명
  │      Authorization { address: implContract, nonce: EOA_nonce }
  │
  └─ 3. POST /api/relay { witnessSig, authorization }
         → 릴레이어가 Type 4 TX 전송, USDC 이동 완료
```

**EIP-7702 XLayer 체인 (xlayer)**
```
q402xl.pay() 호출
  ├─ 0. GET /api/relay/info → facilitator 주소 조회
  │
  ├─ 1. TransferAuthorization EIP-712 서명
  │      domain: { name="Q402 X Layer", verifyingContract=유저EOA }
  │      types:  TransferAuthorization { owner, facilitator, token, recipient, amount, nonce, deadline }
  │      nonce:  random uint256
  │
  ├─ 2. EIP-7702 authorization 서명
  │      address: 0x31E9D105... (Q402PaymentImplementationXLayer)
  │
  └─ 3. POST /api/relay { witnessSig, authorization, xlayerNonce }
         → 릴레이어가 Type 4 TX 전송, OKB 가스 대납
         → transferWithAuthorization() 실행, USDC 이동 완료
```

---

## 11. 대시보드 페이지

파일: `app/dashboard/page.tsx`

### 4개 탭

#### Overview 탭
- 일별 TX 차트 (bar chart, SVG)
- API Key 표시 (마스킹 + 복사 버튼)
- 릴레이 TX 할당량 (플랜별)
- 최근 TX 목록
- 이메일 알림 설정 (UI 존재; 발송 기능은 추후 구현 예정)

#### Gas Tank 탭
두 개 구역으로 분리:

**릴레이어 전체 잔고** (읽기전용)
- `GET /api/gas-tank` 호출
- 4개 체인 온체인 잔고 실시간 표시

**내 입금 잔고** (클라이언트별)
- `GET /api/gas-tank/user-balance?apiKey=q402_live_xxx`
- Deposit 버튼 → DepositModal

**DepositModal 플로우**
```
loading(1.5초) → address(릴레이어 주소 표시 + 복사)
                          ↓ 유저가 입금 후 "Verify Deposit" 클릭
              → checking(스캔 중)
                          ↓
              → deposit_verified(잔고 업데이트됨)
              또는 not_found(입금 미발견)
```

#### Developer 탭
4단계 Integration Guide:
1. SDK 로드
2. Q402Client 초기화
3. `q402.pay()` 호출
4. 응답 구조 설명

#### Transactions 탭
- 릴레이 TX 이력 목록 (`GET /api/transactions?apiKey=q402_live_xxx`)

---

## 12. v1.4 신규 기능 (2026-04-08)

### 12-A. Sandbox 모드

`q402_test_` 접두사 API Key는 온체인 트랜잭션 없이 mock 응답을 반환한다.

**동작 방식:**
- `/api/keys/provision` 호출 시 live key와 함께 sandbox key 자동 발급
- Relay 요청 수신 시 `isSandbox` 감지:
  ```typescript
  const isSandbox = keyRecord.isSandbox === true || apiKey.startsWith("q402_test_");
  ```
- sandbox 경로: 400ms 지연 후 mock txHash/blockNumber 반환, 가스 소비 없음
- 실제 TX 기록(DB)에는 sandbox 플래그 포함되어 저장됨

**KV 데이터:**
- `sub:{addr}.sandboxApiKey` — sandbox key 저장
- `apikey:{q402_test_xxx}.isSandbox = true`

---

### 12-B. Webhook 시스템

성공적인 릴레이 TX마다 등록된 엔드포인트로 HMAC-SHA256 서명된 이벤트 전송.

**엔드포인트:**
- `POST /api/webhook` — URL 등록 (최초 등록 시에만 secret 반환, 재등록 시 기존 secret 유지)
- `GET /api/webhook?address=0x&sig=0x` — 현재 설정 조회 (secret 미포함)
- `DELETE /api/webhook` — 설정 삭제
- `POST /api/webhook/test` — 테스트 이벤트 발송

**페이로드 구조:**
```json
{
  "event": "relay.success",
  "sandbox": false,
  "txHash": "0x...",
  "chain": "avax",
  "from": "0xUSER",
  "to": "0xRECIPIENT",
  "amount": 5.0,
  "token": "USDC",
  "gasCostNative": 0.00042,
  "timestamp": "2026-04-08T12:00:00.000Z"
}
```

**헤더:** `X-Q402-Signature: sha256=HMAC_HEX`

**서버 검증 예시 (Node.js):**
```javascript
const hmac = crypto.createHmac('sha256', process.env.Q402_WEBHOOK_SECRET);
hmac.update(rawBody);
const valid = 'sha256=' + hmac.digest('hex') === req.headers['x-q402-signature'];
```

**SSRF 방어:** 등록 시 + 테스트 시 + relay fire 시 private IP 범위 차단
```
/^(localhost|127\.|0\.0\.0\.0|::1$|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/
```

**KV:** `webhook:{addr}` → `{ url, secret, active, createdAt }`

---

### 12-C. API Key 교체 (Rotation)

`POST /api/keys/rotate` — EIP-191 서명 인증 필요, rate limit: 5req/60s

```
기존 key → deactivateApiKey() → 비활성화
새 key → generateApiKey() → KV 저장
sub:{addr}.apiKey → 새 key로 업데이트
```

교체 후 기존 키로 relay 호출 시 → `"API key has been rotated"` 에러 (401)

---

### 12-D. 실제 가스 비용 계산

`app/lib/relayer.ts`의 모든 settle 함수에서 TX receipt으로부터 실제 가스 비용 계산:

```typescript
// viem (settlePayment, settlePaymentXLayerEIP7702):
const gasCostNative = parseFloat(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));

// ethers (settlePaymentEIP3009):
const gasCostNative = parseFloat(ethers.formatEther(gasUsed * gasPrice));
```

`SettleResult` 인터페이스:
```typescript
export interface SettleResult {
  success: boolean;
  txHash?: string;
  blockNumber?: bigint;
  gasCostNative?: number;   // ← v1.4 추가
  error?: string;
}
```

---

### 12-E. Transactions API 인증 방식 변경

v1.3 이전: `GET /api/transactions?apiKey=q402_live_xxx` (API key 노출 위험)  
v1.4: `GET /api/transactions?address=0x...&sig=0x...` (EIP-191 개인 서명 인증)

```typescript
const recovered = ethers.verifyMessage(PROVISION_MSG(addr), sig);
if (recovered.toLowerCase() !== addr) → 401
```

---

## 12. 미완성 / 다음 단계

| 항목 | 현황 | 우선순위 |
|------|------|---------|
| 프로젝트별 별도 릴레이어 주소 | 현재 단일 글로벌 릴레이어 지갑 사용 | 높음 (P1) |
| Webhook retry on failure | 현재 fire-and-forget; 실패 시 재시도 없음 | 중간 |
| SDK npm 패키지 배포 | 현재 CDN 파일만 (`/q402-sdk.js`) | 낮음 |
| 자동화 테스트 | 미구현 | 중간 |
| PostgreSQL 마이그레이션 | 현재 Vercel KV | 낮음 (KV로 충분) |
| Gas Tank 자동 충전 | UI 토글 존재; 온체인 자동화 로직 미구현 | 중간 |

---

## 13. 환경 변수

파일: `.env.local`

```env
# 릴레이어 지갑 Private Key (가스 대납 지갑)
# 절대 외부에 노출 금지!
RELAYER_PRIVATE_KEY=0x...

# Q402PaymentImplementation 컨트랙트 주소 (v1.3)
IMPLEMENTATION_CONTRACT=0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c
BNB_IMPLEMENTATION_CONTRACT=0x6cF4aD62C208b6494a55a1494D497713ba013dFa
ETH_IMPLEMENTATION_CONTRACT=0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD
XLAYER_IMPLEMENTATION_CONTRACT=0x8D854436ab0426F5BC6Cc70865C90576AD523E73
STABLE_IMPLEMENTATION_CONTRACT=0x2fb2B2D110b6c5664e701666B3741240242bf350

# Vercel KV (Redis) — 모든 데이터 영속성
KV_REST_API_URL=https://...
KV_REST_API_TOKEN=...

# Admin 전용 엔드포인트 보호 (x-admin-secret 헤더)
ADMIN_SECRET=your_admin_secret_here
```

---

## 14. 체인별 컨트랙트 현황

### 지원 체인

| 체인 | ChainID | 릴레이 컨트랙트 | EIP-712 NAME | 상태 |
|------|---------|----------------|-------------|------|
| Avalanche C-Chain | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | Q402 Avalanche | ✅ 배포완료 + 테스트 성공 |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | Q402 BNB Chain | ✅ 배포완료 |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | Q402 Ethereum | ✅ 배포완료 |
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | Q402 X Layer | ✅ EIP-7702 테스트 성공 (2026-03-12) |
| **Stable** | **988** | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | Q402 Stable | ✅ 배포완료 (v1.2, 2026-04-07) |

### 토큰 주소

#### Avalanche
| 토큰 | 주소 | Decimals |
|------|------|---------|
| USDC | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 6 |
| USDT | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | 6 |

#### BNB Chain
| 토큰 | 주소 | Decimals | 비고 |
|------|------|---------|------|
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | Binance 래핑, EIP-2612 미지원 |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 | |

#### Ethereum
| 토큰 | 주소 | Decimals |
|------|------|---------|
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |

#### X Layer
| 토큰 | 주소 | Decimals | 비고 |
|------|------|---------|------|
| USDC | `0x74b7F16337b8972027F6196A17a631aC6dE26d22` | 6 | EIP-2612 + EIP-3009 모두 지원 |
| USDT | `0x1E4a5963aBFD975d8c9021ce480b42188849D41D` | 6 | |

### Q402PaymentImplementation 컨트랙트 ABI 요약

```solidity
// EIP-7702로 위임된 EOA에서 실행됨
function pay(
  address owner,      // 결제자 EOA
  address token,      // USDC/USDT 토큰 주소
  uint256 amount,     // atomic 단위 (USDC: 1 = 0.000001 USDC)
  address to,         // 수신자
  uint256 deadline,   // 유닉스 타임스탬프 만료 시간
  bytes32 paymentId,  // 중복 방지 고유 ID
  bytes calldata witnessSig  // EIP-712 서명
) external;

function payBatch(
  address owner,
  tuple(address token, uint256 amount, address to)[] items,
  uint256 deadline,
  bytes32 paymentId,
  bytes calldata witnessSig
) external;
```

---

## 마스터 계정

테스트 및 내부 관리용으로 항상 paid 처리되는 주소:

```
0xfc77ff29178b7286a8ba703d7a70895ca74ff466  (릴레이어 지갑)
0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28  (오너 지갑)
```

- `app/lib/access.ts`의 `MASTER_ADDRESSES` 배열에 하드코딩
- v1.1에서는 isPaid가 항상 true이므로 실질적인 게이팅 효과 없음 (결제 복원 시 재활성화)

---

## 15. 보안 패치 이력 (v1.2)

**감사일**: 2026-03-23
**감사자**: Marin
**대상 컨트랙트**: 4개 체인 (ETH / BNB / Avalanche / XLayer)

---

### [P0] Owner Binding 누락 — 치명

**문제**
`transferWithAuthorization`에서 `owner != address(this)` 검증이 없었음.
EIP-7702 위임 실행 컨텍스트에서 서명한 `owner`와 실제 토큰이 출금되는 EOA가 달라질 수 있어, 타 주소의 자산을 무단 이전하는 벡터가 존재했음.

**수정**
```solidity
// transferWithAuthorization 상단에 추가
if (owner == address(0)) revert InvalidOwner();
if (owner != address(this)) revert OwnerMismatch();
```

**신규 에러**: `error OwnerMismatch()`, `error InvalidOwner()`

---

### [P1] Facilitator 미검증 — 높음

**문제**
`msg.sender == facilitator` 체크가 없어서 제3자가 인터셉트된 페이로드를 직접 실행할 수 있었음. `transferWithAuthorization`과 `transferFromWithAuthorization` 두 함수 모두 영향.

**수정**
```solidity
// 두 transfer 함수 상단에 추가
if (msg.sender != facilitator) revert UnauthorizedFacilitator();
```

**신규 에러**: `error UnauthorizedFacilitator()`

**백엔드 연동**: `relayer.ts`에서 모든 체인에 대해 facilitator 주소를 명시적으로 전달하도록 업데이트.

---

### [P2-A] Signature Recovery 강화 — 중간

**문제**
`ecrecover` 결과에 대한 zero-address 검증 없음. ECDSA 서명 가변성(malleability) 방어를 위한 low-s 강제도 없었음.

**수정**
```solidity
function _recoverSigner(...) internal pure returns (address) {
    address signer = ecrecover(digest, v, r, s);
    if (signer == address(0)) revert InvalidSignature();
    if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0)
        revert InvalidSignature();
    return signer;
}
```

---

### [P2-B] Digest 헬퍼 함수 WARNING 주석 추가 — 중간

**문제**
`domainSeparator()`와 `hashTransferAuthorization()`이 EIP-7702 위임 실행 컨텍스트에서는 일반 호출과 다른 값을 반환함 (`address(this)`가 달라짐). 이 사실이 문서화되지 않아 외부 통합 시 오용 가능성 존재.

**수정**
두 헬퍼 함수에 `@dev WARNING` 주석 추가 — EIP-7702 위임 실행 시 `address(this)` 동작 차이 경고.

---

### [P3] 체인별 주석 불일치 수정 — 낮음

**문제**
ETH / BNB / XLayer 컨트랙트 헤더에 Avalanche/Fuji 관련 stale 주석이 잔존.

**수정**
각 컨트랙트 헤더를 해당 체인에 맞게 수정:
- ETH: Chain ID 1, ETH gas, USDC on Ethereum
- BNB: Chain ID 56, BNB gas, USDC on BNB Chain
- Avalanche: Chain ID 43114, AVAX gas
- XLayer: Chain ID 196, OKB gas

---

### 재배포 정보

v1.2 패치 적용 후 4개 체인 전체 재배포. 새 컨트랙트 주소:

| Chain | ChainID | New Address |
|-------|---------|-------------|
| Avalanche | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` |
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` |

검증 완료: ETH/BNB → Sourcify perfect match, Avalanche → Routescan, X Layer → OKLink 수동 검증.

---

## 16. Stable 체인 통합 (v1.3) — 2026-03-30

### 개요

Stable (stable.xyz) — Layer 1 블록체인. USDT0가 네이티브 가스 토큰.
Q402 on Stable의 핵심 가치: 단일 Gas Tank로 수백 개의 AI 에이전트 가스 통합 관리.

### 네트워크 정보

| 항목 | Mainnet | Testnet |
|------|---------|---------|
| Chain ID | `988` | `2201` |
| RPC | `https://rpc.stable.xyz` | `https://rpc.testnet.stable.xyz` |
| Explorer | `https://stablescan.xyz` | `https://testnet.stablescan.xyz` |
| 가스 토큰 | USDT0 (18 decimals) | USDT0 |
| USDT0 주소 | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | `0x78Cf24370174180738C5B8E352B6D14c83a6c9A9` |

### 배포된 컨트랙트

| Chain | Address |
|-------|---------|
| Stable Testnet (2201) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |
| Stable Mainnet (988) | `0x2fb2B2D110b6c5664e701666B3741240242bf350` |

같은 주소 — deployer 주소/nonce 동일해서 deterministic 배포됨.

### EIP-712 도메인 (Stable)

```javascript
{
  name:              "Q402 Stable",
  version:           "1",
  chainId:           988,
  verifyingContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350"  // impl contract
}
```

> X Layer와 달리 verifyingContract = impl contract (유저 EOA 아님)

### 릴레이 방식

avax/bnb/eth와 동일한 `settlePayment()` 사용. `stableNonce` 파라미터 추가.

### SDK v1.3.0 변경사항

```javascript
// 새로 추가된 체인
stable: {
  chainId: 988,
  mode: "eip7702_stable",
  domainName: "Q402 Stable",
  implContract: "0x2fb2B2D110b6c5664e701666B3741240242bf350",
  usdt: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 18 },
}
```

### Partnership 현황

- Stable 팀 (Eunice)과 Partnership Announcement 협의 중
- Twitter 공동 발표: Quack AI 포스팅 → Stable RT/QT
- 예정일: 2026-04-04 (금) 19:00 HKT
- 상세 스펙: `Q402_STABLE_INTEGRATION.md` 참조

검증 상태: ETH ✅ Sourcify Perfect Match · BNB ✅ Sourcify Perfect Match · Avalanche ✅ Snowtrace · XLayer ✅ OKLink
