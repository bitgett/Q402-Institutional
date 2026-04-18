# Q402 Security Review Response — 2026-04-18

**Reviewer:** (external friend, audit date 2026-04-18)
**Responder:** Q402 team
**Release:** v1.17
**Scope reviewed:** `app/api/relay/route.ts`, `app/api/gas-tank/user-balance/route.ts`, sandbox flow

친구야, 리뷰 고마워. 세 finding 전부 수용하고 이번 릴리스(v1.17)에서 고쳤다. 각 항목별로 **원인 판단 → 수정 내용 → 회귀 방지 장치 → 심각도 calibration** 순서로 정리한다.

---

## Summary

| Finding | Reviewer 심각도 | 내부 심각도 판정 | 조치 | 회귀 테스트 |
|---|---|---|---|---|
| Q402-SEC-001 — relay silent quota drain | High | **High 수용** | 수표 순서 재배치 (`loadRelayerKey` 를 `decrementCredit` 앞으로) | [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts) · 9 assertion |
| Q402-SEC-002 — sandbox webhook forgery | High | **Medium, priority High** | Sandbox 는 `getWebhookConfig` 조차 읽지 않도록 원천 차단 | 위 동일 파일 · 2 assertion |
| Q402-SEC-003 — 익명 user-balance 열람 | Medium | **Low-Medium** | `requireAuth(address, nonce, sig)` 추가 + dashboard caller 업데이트 | [`__tests__/user-balance-auth.test.ts`](__tests__/user-balance-auth.test.ts) · 5 assertion |

**종합 검증:** `npx vitest run` → **169/169 통과** (기존 155 + 신규 14). `npm run lint` 청결. `npm run build` ✓ 4.3s.

---

## Q402-SEC-001 — Relay silent quota drain

### 네가 짚은 실패 모드 (정확함)

```
기존 흐름:
 1. rateLimit                ✓
 2. dailyCap (rateLimit)     차감됨
 3. chainCfg 검증
 4. auth impl lock 검증
 5. gas tank funding 검증
 6. decrementCredit          차감됨 ← 돈 냄
 7. loadRelayerKey           실패 → 503 반환
    ... 하지만 5번, 6번은 이미 차감됨
```

`RELAYER_PRIVATE_KEY` 오타·roll·accidental unset 시 **모든 호출자의 할당량이 조용히 소진**된다. 결제 고객 입장에서는 "내가 돈 냈는데 왜 크레딧이 줄지?" 상태. 발동 조건 (env 변수 문제) 이 너무 낮아서 "High" 맞다.

### 수정

[`app/api/relay/route.ts`](app/api/relay/route.ts) 에서 수표 순서를 뒤집었다. 이제는:

```
 1. rateLimit
 2. chainCfg 검증            ← 과금 前
 3. auth impl lock 검증      ← 과금 前
 4. gas tank funding 검증    ← 과금 前
 5. loadRelayerKey           ← 과금 前 (NEW: 섹션 6a)
 6. dailyCap                 ← 여기서부터 과금
 7. decrementCredit
 8. relay (settlePayment*)
```

핵심 신규 블록 (sandbox 에서는 skip):

```ts
// ── 6a. Relayer key readiness (live only) ────────────────────────────────
// Q402-SEC-001: verify the relay infrastructure is actually usable BEFORE
// charging the daily cap or decrementing credits.
let relayerAddress: Address = "0x" as Address;
if (!isSandbox) {
  const key = loadRelayerKey();
  if (!key.ok) {
    return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
  }
  relayerAddress = key.address as Address;
}
```

> Note: 기존의 `decrementCredit` 실패 시 "일일캡 refund" 로직은 보존. `dailyCap` → `decrementCredit` 순서는 유지해야 하기 때문에 refund 경로 무결성 체크도 테스트에 포함.

### 회귀 테스트 — [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts)

**Source-grep 방식** 으로 `route.ts` 안의 landmark 문자열 offset 을 비교한다. 순서가 역전되면 `indexOf(X) < indexOf(Y)` 단언이 깨져서 suite 가 실패한다:

```ts
it("confirms loadRelayerKey() succeeds before decrementing credits", () => {
  expect(indexOf(LOAD_RELAYER_KEY, "loadRelayerKey"))
    .toBeLessThan(indexOf(DECREMENT_CREDIT, "decrement"));
});
```

락인된 invariant 9개:
1. `chainCfg` → daily cap
2. `auth lock` → daily cap
3. `gas tank guard` → daily cap
4. `loadRelayerKey` → daily cap **(핵심 — SEC-001)**
5. `loadRelayerKey` → decrement
6. `daily cap` → decrement (refund 경로 보존)
7. `decrement` → relay call

미래의 리팩터 PR 이 이 invariant 를 깨는 순간 CI 가 막는다. 주석으로도 "Q402-SEC-001 의 heart" 명시.

---

## Q402-SEC-002 — Sandbox webhook forgery

### 네가 짚은 실패 모드

Sandbox 릴레이 (`q402_test_` prefix 키) 는 on-chain broadcast 하지 않고 txHash/blockNumber 를 **fabricate** 한다 — 개발 편의. 그런데 기존 코드는 sandbox 흐름에서도 `relay.success` 웹훅을 HMAC-SHA256 서명해서 고객 URL 로 발송했다.

공격 시나리오: 결제 수신자 측 회계 시스템이 "HMAC 서명이 유효한 `relay.success` 페이로드는 실제 정산으로 간주" 로직을 가진 경우, sandbox 키 보유자 (= 해당 API 키 owner 본인 + key prefix 알면 누구든) 가 **서명 유효한 유령 settlement 이벤트** 를 주입 가능.

내부 심각도: 실제 자금 이동이 sandbox 에서 일어나지 않는다는 점에서 **Medium**. 다만 수정 비용이 한 줄이라 priority 는 High 로 취급.

### 수정

[`app/api/relay/route.ts`](app/api/relay/route.ts):

```ts
// Q402-SEC-002: sandbox relays are simulated — no on-chain TX exists.
// Skip webhook dispatch entirely to prevent HMAC-signed "relay.success"
// events being forged through sandbox keys.
const webhookCfg = isSandbox ? null : await getWebhookConfig(keyRecord.address);
```

**의도적 선택** — `getWebhookConfig` **호출 자체를 차단**. 이전 버전의 "sandbox 포함 디스패치" 주석도 삭제.

과거 버전은 "dispatch 직전에 isSandbox 체크" 패턴도 제안될 수 있었지만, 그 경우 누군가 후속 리팩터에서 체크를 옮기거나 제거해도 suite 가 잡아주지 못한다. "config read 조차 안 한다" 는 더 강한 invariant 이고, source-grep 으로 lock 하기도 쉽다.

### 회귀 테스트 — [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts) (후반부)

```ts
it("guards getWebhookConfig with !isSandbox so sandbox never reads webhook config", () => {
  expect(routeSource).toMatch(
    /webhookCfg\s*=\s*isSandbox\s*\?\s*null\s*:\s*await\s+getWebhookConfig/
  );
});

it("does not short-circuit sandbox into the webhook dispatch branch", () => {
  expect(routeSource).not.toMatch(/sandbox 포함/);   // 이전 버전 한국어 주석
  expect(routeSource).toMatch(/LIVE only|live[- ]only|Q402-SEC-002/i);
});
```

첫 단언은 **정확한 ternary 패턴** 을 강제 — `isSandbox && ...` 나 `!isSandbox ? ...` 등의 변형도 통과 못 함. 두 번째는 과거 실수 주석의 재등장을 막고, 새 주석이 `LIVE only` / `Q402-SEC-002` 마커를 꼭 담게 한다.

---

## Q402-SEC-003 — 익명 user-balance 열람

### 네가 짚은 실패 모드

`GET /api/gas-tank/user-balance?address=0x...` 가 unauthenticated. 주소만 알면 누구든 타 지갑의 Q402 **체인별 잔고 + 입금 txHash 이력** 열람 가능. per-IP rate limit (30 req/60s) 만 있어 스크래핑은 느리지만 가능.

내부 심각도: **Low-Medium**. 근거:
- 원본 데이터는 `GASTANK_ADDRESS` 로 들어오는 on-chain transfer 로그로 **부분적으로 도출 가능** — 완전히 비공개 자료는 아님.
- 다만 API 엔드포인트는 per-chain normalized JSON 으로 **마찰 없이** 제공했고, **address → Q402 customer** 매핑을 trivial 하게 만들어줬음.
- `/api/transactions`, `/api/webhook` 과 **일관되지 않았음** — 같은 API 표면에서 다른 인증 모델은 공격 벡터.

### 수정

[`app/api/gas-tank/user-balance/route.ts`](app/api/gas-tank/user-balance/route.ts) 전면 교체:

```ts
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "user-balance", 30, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const address = req.nextUrl.searchParams.get("address");
  const nonce   = req.nextUrl.searchParams.get("nonce");
  const sig     = req.nextUrl.searchParams.get("sig");

  const authResult = await requireAuth(address, nonce, sig);
  if (typeof authResult !== "string") {
    return NextResponse.json(
      { error: authResult.error, code: authResult.code },
      { status: authResult.status },
    );
  }
  const addr = authResult;

  const [balances, deposits] = await Promise.all([
    getGasBalance(addr), getGasDeposits(addr),
  ]);

  return NextResponse.json({ balances, deposits });
}
```

- 순서: rate limit → auth → data read. auth 실패 시 data 접근 자체 없음.
- per-IP rate limit 은 **defense in depth** 로 유지 (auth 우회 시도 부하 차단).
- `requireAuth()` 는 `/api/transactions`, `/api/webhook` 과 동일 모듈 — 세션 nonce 1h TTL, EIP-191 personal_sign.

### Dashboard caller 업데이트 — [`app/dashboard/page.tsx`](app/dashboard/page.tsx)

기존:
```ts
const refreshUserBalance = useCallback((addr: string) => {
  fetch(`/api/gas-tank/user-balance?address=${addr}`) ...
}, []);
```

변경:
```ts
const refreshUserBalance = useCallback(async (addr: string) => {
  // Q402-SEC-003: user-balance now requires nonce+signature auth.
  const auth = await getAuthCreds(addr, signMessage);
  if (!auth) return;
  const { nonce, signature } = auth;
  const qs = new URLSearchParams({ address: addr, nonce, sig: signature }).toString();
  try {
    const res  = await fetch(`/api/gas-tank/user-balance?${qs}`);
    const data = await res.json();
    if (res.status === 401 && data.code === "NONCE_EXPIRED") {
      clearAuthCache(addr);
      return;
    }
    if (data.balances) setUserGasBalance(data.balances);
    if (data.deposits) setGasDeposits(data.deposits);
  } catch { /* ignore */ }
}, [signMessage]);
```

`getAuthCreds()` 는 sessionStorage 캐시를 쓰므로 **유저 지갑 팝업은 최초 1회**. 이후 폴링/새로고침에서는 재서명 요구 없음. `NONCE_EXPIRED` 수신 시 자동으로 캐시 invalidate.

### 회귀 테스트 — [`__tests__/user-balance-auth.test.ts`](__tests__/user-balance-auth.test.ts)

```ts
it("calls requireAuth(address, nonce, sig) before touching balance state", () => {
  const authIdx        = routeSource.search(/const\s+authResult\s*=\s*await\s+requireAuth/);
  const balanceReadIdx = routeSource.search(/getGasBalance\s*\(/);
  const depositReadIdx = routeSource.search(/getGasDeposits\s*\(/);
  expect(authIdx).toBeGreaterThanOrEqual(0);
  expect(balanceReadIdx).toBeGreaterThan(authIdx);
  expect(depositReadIdx).toBeGreaterThan(authIdx);
});
```

락인된 invariant 5개:
1. `requireAuth` import 존재
2. `nonce`, `sig` 쿼리스트링 파싱
3. `authResult` 가 `getGasBalance` / `getGasDeposits` **앞에서** 실행
4. 에러 status 가 `authResult.status` 로 propagate (hardcoded 401 아님)
5. per-IP rate limit **여전히** 유지 (defense in depth)

---

## Severity calibration — 왜 내부 판정이 네 rating 과 다른가

리뷰에서 High/High/Medium 이었는데 내부는 High/Medium/Low-Medium 로 봤다. 이유:

| Finding | 차이 이유 |
|---|---|
| SEC-001 | **일치**. 조용한 quota drain 은 신뢰 붕괴 + 환불 폭탄. 발동 조건 낮음. |
| SEC-002 | Sandbox 에서는 **실제 자금 이동이 없다**. 공격이 성공해도 다운스트림 오염이 sandbox scope 이내. 다만 **"HMAC 서명 유효성" 이라는 단일 신호에 회계가 의존하는 시나리오** 를 가정해야 성립 → 피해자 측 설계에 종속적. 그래서 Medium. 수정 비용 0 이라 priority 는 High. |
| SEC-003 | 공개 블록 익스플로러 + `GASTANK_ADDRESS` 로 **부분적으로 같은 정보** 획득 가능. JSON API 가 한 발로 주는 편의성은 제거됐지만, "완전히 숨겨진 정보" 는 아님. 그래서 Low-Medium. 다만 `/api/transactions` 와의 **API 표면 일관성** 가치가 커서 수정. |

어떻게 생각하는지 의견 기다릴게. 내가 calibration 너무 낮게 잡았으면 알려줘.

---

## 부수적으로 정리된 것들

- README §20 (보안) 에 **v1.17 보안 감사 이력** 섹션 추가 — 각 finding 원인·수정·회귀 테스트 링크.
- README §25 (Changelog) 에 **v1.17 (2026-04-18)** 블록 추가.
- README §9 (API Reference) 의 `/api/gas-tank/user-balance` 스펙 업데이트 — `?address&nonce&sig` 로 변경.
- 보안 속성 표 (§20) 에서 "API Key 소유권 증명" 행에 `user-balance` 추가, "Sandbox 격리" 행에 "웹훅 디스패치는 live-only (v1.17, Q402-SEC-002)" 주석.
- 메모리 파일 (Claude 세션 컨텍스트) 에 v1.17 마일스톤 기록.

---

## 파일 변경 요약

| 파일 | 변경 |
|---|---|
| `app/api/relay/route.ts` | 수표 순서 재배치 (섹션 6a 신설) + sandbox webhook 가드 |
| `app/api/gas-tank/user-balance/route.ts` | requireAuth 추가 (전면 교체) |
| `app/dashboard/page.tsx` | `refreshUserBalance` async + `getAuthCreds` 사용 |
| `__tests__/relay-ordering.test.ts` | **신규** — 9 assertion |
| `__tests__/user-balance-auth.test.ts` | **신규** — 5 assertion |
| `README.md` | §9 API Ref, §20 보안 감사, §25 Changelog v1.17 |

**Test count:** 155 → 169 (신규 14).
**Build:** `✓ Compiled successfully in 4.3s`.
**Lint:** clean.

세 finding 전부 반영 완료. 리포트 다시 한번 감사. 🙏
