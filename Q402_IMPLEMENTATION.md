# Q402 — 전체 구현 문서

> 작성일: 2026-03-10 / 최종 업데이트: 2026-03-12
> 프로젝트 경로: `C:/Users/user/q402-landing/`
> 기술 스택: Next.js 14 App Router · TypeScript · ethers.js v6 · viem · Tailwind CSS · framer-motion

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [디렉터리 구조](#2-디렉터리-구조)
3. [데이터베이스 구조 (db.json)](#3-데이터베이스-구조)
4. [프론트엔드 — 지갑 연결](#4-프론트엔드--지갑-연결)
5. [결제 감지 & 구독 활성화 플로우](#5-결제-감지--구독-활성화-플로우)
6. [API Key 발급 & 검증](#6-api-key-발급--검증)
7. [Gas Tank — 릴레이어 잔고](#7-gas-tank--릴레이어-잔고)
8. [Gas Tank — 유저 입금 잔고](#8-gas-tank--유저-입금-잔고)
9. [EIP-7702 릴레이 트랜잭션](#9-eip-7702-릴레이-트랜잭션)
10. [클라이언트 SDK (q402-sdk.js)](#10-클라이언트-sdk)
11. [대시보드 페이지](#11-대시보드-페이지)
12. [미완성 / 다음 단계](#12-미완성--다음-단계)
13. [환경 변수](#13-환경-변수)
14. [체인별 컨트랙트 현황](#14-체인별-컨트랙트-현황)

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
│   │   │   ├── check/route.ts          # GET  — 결제 여부 확인
│   │   │   └── activate/route.ts       # POST — 구독 활성화 + API Key 발급
│   │   ├── keys/
│   │   │   ├── generate/route.ts       # POST — API Key 재발급
│   │   │   └── verify/route.ts         # POST — API Key 유효성 검증
│   │   ├── gas-tank/
│   │   │   ├── route.ts                # GET  — 릴레이어 온체인 잔고 (전체)
│   │   │   ├── verify-deposit/route.ts # POST — 유저 입금 스캔 후 DB 기록
│   │   │   └── user-balance/route.ts   # GET  — 유저 입금 잔고 조회
│   │   ├── wallet-balance/route.ts     # GET  — 유저 지갑 잔고 (4체인)
│   │   └── relay/
│   │       ├── route.ts                # POST — EIP-7702 / EIP-3009 릴레이 TX 제출
│   │       └── info/route.ts           # GET  — facilitator 주소 반환 (SDK용)
│   ├── lib/
│   │   ├── db.ts                       # JSON DB CRUD 헬퍼
│   │   ├── blockchain.ts               # ERC-20 Transfer 이벤트 스캔
│   │   ├── relayer.ts                  # viem EIP-7702 settlePayment() / settlePaymentXLayerEIP7702() / settlePaymentEIP3009()
│   │   ├── access.ts                   # isPaid / setPaid / MASTER_ADDRESSES
│   │   └── wallet.ts                   # connectWallet / getConnectedAccount
│   ├── context/
│   │   └── WalletContext.tsx           # 전역 지갑 상태 (localStorage 즉시 복원)
│   ├── components/
│   │   ├── WalletButton.tsx            # 지갑 연결 모달 + PaymentRequiredPopup
│   │   ├── Navbar.tsx
│   │   ├── Hero.tsx
│   │   ├── HowItWorks.tsx
│   │   ├── Pricing.tsx
│   │   ├── Contact.tsx
│   │   └── Footer.tsx
│   ├── dashboard/page.tsx              # 대시보드 (4개 탭)
│   ├── payment/page.tsx                # Quote Builder
│   ├── docs/page.tsx                   # 개발자 문서
│   └── page.tsx                        # 랜딩 메인
├── data/
│   └── db.json                         # 런타임 DB (JSON 파일)
├── public/
│   ├── q402-sdk.js                     # 클라이언트 SDK (배포용)
│   ├── bnb.png / eth.png / avax.png / xlayer.png
│   └── arbitrum.png / scroll.png
└── .env.local                          # RELAYER_PRIVATE_KEY
```

---

## 3. 데이터베이스 구조

파일: `data/db.json`
서버 사이드에서 fs.readFileSync/writeFileSync로 읽고 씀. (프로덕션에서는 PostgreSQL/Redis로 교체 필요)

```json
{
  "subscriptions": {
    "0xOwnerAddress": {
      "paidAt": "2026-03-10T00:00:00.000Z",
      "apiKey": "q402_live_xxx",
      "plan": "growth",
      "txHash": "0xOnChainPaymentTxHash",
      "amountUSD": 99
    }
  },
  "apiKeys": {
    "q402_live_xxx": {
      "address": "0xOwnerAddress",
      "createdAt": "2026-03-10T00:00:00.000Z",
      "active": true,
      "plan": "growth"
    }
  },
  "gasDeposits": {
    "0xOwnerAddress": [
      {
        "chain": "avax",
        "token": "AVAX",
        "amount": 1.5,
        "txHash": "0xDepositTxHash",
        "depositedAt": "2026-03-10T00:00:00.000Z"
      }
    ]
  },
  "relayedTxs": {
    "0xOwnerAddress": [
      {
        "apiKey": "q402_live_xxx",
        "address": "0xOwnerAddress",
        "chain": "avax",
        "fromUser": "0xPayer",
        "toUser": "0xRecipient",
        "tokenAmount": 5.0,
        "tokenSymbol": "USDC",
        "gasCostNative": 0,
        "relayTxHash": "0xRelayTxHash",
        "relayedAt": "2026-03-10T00:00:00.000Z"
      }
    ]
  }
}
```

### DB 헬퍼 함수 (`app/lib/db.ts`)

| 함수 | 역할 |
|------|------|
| `getSubscription(address)` | 구독 조회 |
| `setSubscription(address, data)` | 구독 저장/갱신 |
| `getApiKeyRecord(apiKey)` | API Key → 레코드 조회 |
| `generateApiKey(address, plan)` | 새 API Key 생성 후 저장 |
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
- 연결됨 + 미결제: PaymentRequiredPopup 팝업 (createPortal로 중앙 렌더링)
- 연결됨 + 결제완료: `MY PAGE` 버튼 (sparkle 반짝 애니메이션)

### 결제 게이팅 (`app/lib/access.ts`)

```typescript
const MASTER_ADDRESSES = [
  "0xfc77ff29178b7286a8ba703d7a70895ca74ff466",
  "0xf5cdcd89b7dae1484197a4a65b97cd7a5e945c28",
];

isPaid(address)  // MASTER_ADDRESSES 포함 여부 or localStorage 확인
setPaid(address) // localStorage에 q402_paid_{address} = "true" 저장
```

---

## 5. 결제 감지 & 구독 활성화 플로우

### 개요

유저가 릴레이어 주소(`0xfc77...`)로 USDC/USDT를 직접 전송 → API가 온체인에서 Transfer 이벤트 스캔 → 구독 활성화 + API Key 발급

### 플랜 매핑

| 금액 (ETH 기준) | 플랜 | TX/월 |
|----------------|------|-------|
| $670+ | Growth | 50,000 |
| $1,200+ | Scale | 100,000 |
| $3,000+ | Business | 100K~500K |
| Custom | Enterprise | 500K+ |

### 결제 확인 API

**`GET /api/payment/check?address=0x...`**

1. DB에 이미 구독 있으면 `{ status: "already_paid" }` 즉시 반환
2. `checkPaymentOnChain(address)` 호출 — 3개 체인 병렬 스캔
3. 결과 반환: `payment_found` / `not_found` / `amount_too_low`

### 구독 활성화 API

**`POST /api/payment/activate`** — body: `{ address }`

1. 이미 구독 있으면 `{ status: "already_active", apiKey }` 반환
2. `checkPaymentOnChain(address)` 재확인
3. `generateApiKey(address, plan)` — API Key 생성
4. `setSubscription(address, {...})` — DB 저장
5. 반환: `{ status: "activated", apiKey, plan }`

### 블록체인 스캔 (`app/lib/blockchain.ts`)

```
BNB Chain   : 최근 2000 블록 (약 1.7시간, 블록타임 3초)
Ethereum    : 최근 500 블록  (약 1.7시간, 블록타임 12초)
Avalanche   : 최근 2000 블록 (약 1.1시간, 블록타임 2초)
X Layer     : 최근 3000 블록 (약 1.7시간, 블록타임 2초)
```

- `Promise.allSettled`로 4개 체인 병렬 조회
- ERC-20 Transfer 이벤트 필터: `from=유저주소, to=릴레이어주소`
- 여러 건 있으면 금액 가장 큰 것 선택

---

## 6. API Key 발급 & 검증

### API Key 형식

```
q402_live_{랜덤16자}
예: q402_live_k3m9xp2jf8ab1z7q
```

### API Key 재발급

**`POST /api/keys/generate`** — body: `{ address }`

- 이미 결제된 주소에 한해서만 새 키 발급
- 기존 구독의 플랜은 그대로 유지
- 새 키가 db.apiKeys에 추가됨

### API Key 검증

**`POST /api/keys/verify`** — body: `{ apiKey }`

```json
// 응답 (유효)
{
  "valid": true,
  "address": "0xOwnerAddress",
  "plan": "growth",
  "createdAt": "2026-03-10T00:00:00.000Z"
}

// 응답 (무효)
{ "valid": false }
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

**`GET /api/gas-tank/user-balance?address=0x...`**

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
  sum(gasDeposits[address].amount)     // 누적 입금
- sum(relayedTxs[address].gasCostNative) // 누적 소비
```

> 현재 gasCostNative는 0으로 기록 (정확한 gas 계산은 미구현 — 다음 단계)

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
| Avalanche | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699` | ✅ 배포완료 + 테스트 성공 |
| BNB Chain | `0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6` | 배포완료 |
| Ethereum  | `0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9` | 배포완료 |

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

#### settlePaymentXLayerEIP7702 내부 (`app/lib/relayer.ts`)

```typescript
// viem으로 Type 4 TX 전송
const callData = encodeFunctionData({
  abi: XLAYER_EIP7702_ABI,
  functionName: "transferWithAuthorization",
  args: [owner, facilitator, token, recipient, amount, nonce, deadline, witnessSig],
});
const txHash = await walletClient.sendTransaction({
  chain: null,
  to: params.owner,   // 유저 EOA
  data: callData,
  gas: BigInt(300000),
  authorizationList: [{ ...params.authorization }],
});
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

### 9-D. 처리 단계 (공통)

1. **API Key 검증** — `getApiKeyRecord(apiKey)`, active 확인
2. **체인별 추가 필드 검증**
   - xlayer: `authorization + xlayerNonce` → EIP-7702 / `eip3009Nonce` → EIP-3009 fallback
   - avax/bnb/eth: `authorization` 필수
3. **Gas Tank 잔고 확인** — `getGasBalance(keyRecord.address)[chain] > 0.0001`
4. **paymentId 처리** — bytes32 hex면 그대로, 문자열이면 keccak256, 없으면 랜덤 생성
5. **체인 분기** — xlayer EIP-7702 → `settlePaymentXLayerEIP7702()` / xlayer EIP-3009 → `settlePaymentEIP3009()` / 기타 → `settlePayment()`
6. **TX 기록** — `recordRelayedTx()` 호출

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

파일: `public/q402-sdk.js`

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

// 2. 결제
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
- 릴레이 TX 할당량 (플랜별: Growth 50K / Scale 100K / Business 500K / Enterprise 무제한)
- 최근 TX 목록

#### Gas Tank 탭
두 개 구역으로 분리:

**릴레이어 전체 잔고** (읽기전용)
- `GET /api/gas-tank` 호출
- 4개 체인 온체인 잔고 실시간 표시

**내 입금 잔고** (클라이언트별)
- `GET /api/gas-tank/user-balance?address=0x...`
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
- 릴레이 TX 이력 목록 (현재 구현 중)

---

## 12. 미완성 / 다음 단계

| 항목 | 현황 | 우선순위 |
|------|------|---------|
| Gas 소비량 정확 계산 | gasCostNative 항상 0 | 높음 |
| BNB/ETH 체인 컨트랙트 배포 | 미배포 | 높음 |
| 구독 만료/갱신 로직 | 미구현 | 중간 |
| Webhook / TX 이벤트 알림 | 미구현 | 중간 |
| DB를 PostgreSQL로 교체 | JSON 파일로 임시 운영 | 높음 (프로덕션) |
| Vercel 배포 | 미배포 | 높음 |
| EIP-7702 authorization 서명 표준화 | 현재 custom typed data 방식 | 중간 |
| SDK npm 패키지 배포 | 현재 CDN 파일만 | 낮음 |
| TX 이력 대시보드 | 탭 UI만 있음 | 낮음 |

---

## 13. 환경 변수

파일: `.env.local`

```env
# 릴레이어 지갑 Private Key (가스 대납 지갑)
# 이 지갑이 각 체인에서 gas를 지불함
# 절대 외부에 노출 금지!
RELAYER_PRIVATE_KEY=0x...

# Q402PaymentImplementation 컨트랙트 주소
IMPLEMENTATION_CONTRACT=0xE5b90D564650bdcE7C2Bb4344F777f6582e05699
BNB_IMPLEMENTATION_CONTRACT=0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6
ETH_IMPLEMENTATION_CONTRACT=0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9
XLAYER_IMPLEMENTATION_CONTRACT=0x31E9D105df96b5294298cFaffB7f106994CD0d0f
```

---

## 14. 체인별 컨트랙트 현황

### 지원 체인

| 체인 | ChainID | 릴레이 컨트랙트 | EIP-712 NAME | 상태 |
|------|---------|----------------|-------------|------|
| Avalanche C-Chain | 43114 | `0xE5b90D564650bdcE7C2Bb4344F777f6582e05699` | Q402 Avalanche | 배포완료 |
| BNB Chain | 56 | `0x8c21b15a90E6E0C0E9807B4024119Faca35C31A6` | Q402 BNB Chain | 배포완료 |
| Ethereum | 1 | `0x1dd4c1E1D07a3C1aEe6e770106e181a498F4D9c9` | Q402 Ethereum | 배포완료 |
| X Layer | 196 | `0x31E9D105df96b5294298cFaffB7f106994CD0d0f` | Q402 X Layer | ✅ EIP-7702 테스트 성공 (2026-03-12) |

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
- 결제/체인 스캔 없이 즉시 Dashboard 접근 가능
- `data/db.json`에 `q402_live_test_masterkey`로 수동 삽입됨
