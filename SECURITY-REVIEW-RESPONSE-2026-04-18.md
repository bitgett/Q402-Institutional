# Q402 Security Review — Full Exchange (2026-04-18)

**Reviewer:** 외부 친구 리뷰어
**Responder:** Q402 팀
**Release:** v1.17
**검증:** 169/169 테스트 통과 · lint 청결 · build ✓ 4.3s

이 문서는 두 부분이다.

- **Part 1** — 친구가 보내준 원본 Security Review Report (전문)
- **Part 2** — 각 finding 별로 어떻게 고쳤는지 (코드 diff + 회귀 테스트)

파일 링크는 전부 레포 루트 기준 상대경로. 커밋 `325b432` 에 전부 포함.

---

# Part 1 — 친구 원본 리포트

> 아래는 친구가 2026-04-18 에 보내준 Security Review Report 의 **변형 없는 전문**. 한 글자도 건드리지 않았다.

## Q402 Security Review Report

Date: 2026-04-18
Scope: Current codebase only
Focus: High-risk issues that could cause fund loss, rights mismatch, or exploitable abuse

### Executive Summary

This review did not identify an obvious path to directly steal end-user on-chain funds without valid signatures.

However, it did identify two high-priority issues and one medium-priority issue:

1. Relay entitlements can be consumed before all non-relay failure conditions are ruled out.
2. Sandbox requests can emit signed success webhooks for transfers that never happened on-chain.
3. Gas tank balances and deposit history are publicly enumerable by wallet address.

The first two issues should be treated as operationally significant because they can create customer-impacting rights mismatches and trusted-but-false downstream events.

### Findings

#### 1. [High] Relay entitlements are consumed before all non-relay failures are ruled out

Rule ID: Q402-SEC-001

Location:
- `app/api/relay/route.ts:226-320`

Severity:
- High

Impact:
- Customers can lose paid relay entitlements even when no relay actually occurs.
- This creates a rights mismatch between billed quota and delivered service.
- In production, this can become a support, billing, and trust issue even without an external attacker draining funds directly.

Evidence:

The route charges the daily cap before all request viability checks are complete:

```ts
const withinDailyCap = await rateLimit(dailyCapKey, "daily", dailyCap, 86400, false);
if (!withinDailyCap) {
  return NextResponse.json({
    error: `Daily relay cap reached (${dailyCap}/day for ${keyRecord.plan} plan). Resets at midnight UTC.`,
  }, { status: 429 });
}
dailyCapCharged = true;
```

It also decrements credits before relayer-key readiness is confirmed:

```ts
await initQuotaIfNeeded(keyRecord.address, subscription?.quotaBonus ?? 0);
const dec = await decrementCredit(keyRecord.address);
...
const key = loadRelayerKey();
if (!key.ok) {
  return NextResponse.json({ error: "Relay not configured" }, { status: 503 });
}
```

Why this is a problem:
- `dailyCapCharged` happens before chain support, authorization consistency, and gas-tank sufficiency are fully resolved.
- `decrementCredit()` happens before `loadRelayerKey()` confirms the relay infrastructure is actually usable.
- Some failure exits do not refund quota or daily-cap usage.

Examples of affected failure classes:
- Unsupported or malformed relay paths after entitlement charging
- Gas tank empty / insufficient operational readiness
- Relayer key missing or mismatched
- Other pre-relay operational failures returning `400`, `402`, or `503`

Recommended Fix:
- Move all daily-cap and credit reservation steps to the last possible point before the actual on-chain relay call.
- Alternatively, centralize all early returns after quota reservation behind a refund path that always rolls back:
  - reserved credit
  - daily-cap charge
- Treat relayer-key readiness as a prerequisite before any customer entitlement is consumed.

Mitigation:
- Add tests that explicitly assert no credit/daily-cap loss on:
  - relayer misconfiguration
  - insufficient gas tank
  - unsupported chain / invalid authorization

---

#### 2. [High] Sandbox requests can produce signed fake success webhooks

Rule ID: Q402-SEC-002

Location:
- `app/api/relay/route.ts:325-333`
- `app/api/relay/route.ts:462-523`

Severity:
- High

Impact:
- A sandbox API key can produce authenticated `relay.success` webhook events for relays that never happened on-chain.
- If downstream systems trust signature validity more than environment separation, they may grant service, goods, credits, or state transitions based on fake success events.
- This is especially risky if customers reuse the same webhook secret or the same handler for sandbox and live traffic.

Evidence:

Sandbox mode fabricates a successful relay result:

```ts
if (isSandbox) {
  await new Promise(r => setTimeout(r, 400));
  result = {
    success: true,
    txHash: `0x${randomBytes(32).toString("hex")}`,
    blockNumber: BigInt(Math.floor(Math.random() * 50_000_000) + 1_000_000),
    gasCostNative: 0.00042,
  };
}
```

The same request path later emits a signed success webhook:

```ts
const payload = JSON.stringify({
  event: "relay.success",
  sandbox: isSandbox,
  txHash: result.txHash,
  ...
});
const hmac = createHmac("sha256", webhookCfg.secret).update(payload).digest("hex");
```

Why this is a problem:
- The HMAC proves the message came from Q402, but does not prove the relay actually happened on-chain.
- A downstream integrator can easily mishandle this if sandbox/live events are not strictly separated.
- The `sandbox: true` field helps, but it is only safe if every consumer enforces it correctly.

Recommended Fix:
- Do not emit the same `relay.success` event type for sandbox.
- Split live and sandbox webhook semantics, for example:
  - `relay.success` for verified live relays only
  - `relay.sandbox_success` or `relay.simulated` for sandbox
- Use a separate webhook secret for sandbox, or disable webhook delivery for sandbox entirely.

Mitigation:
- Require downstream consumers to reject any event with `sandbox: true` unless explicitly running in sandbox mode.
- Document that sandbox callbacks are simulated and must never drive financial or entitlement decisions.

---

#### 3. [Medium] Gas balance and deposit history are publicly enumerable

Rule ID: Q402-SEC-003

Location:
- `app/api/gas-tank/user-balance/route.ts:5-19`

Severity:
- Medium

Impact:
- Anyone who knows a wallet address can query gas balances and deposit history.
- This leaks customer operating posture and can help attackers identify high-value or active accounts.
- It is not a direct asset-theft path by itself, but it meaningfully weakens privacy and targeting resistance.

Evidence:

The endpoint does not require wallet proof-of-ownership:

```ts
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  ...
  const balances = await getGasBalance(address.toLowerCase());
  const deposits = await getGasDeposits(address.toLowerCase());
  return NextResponse.json({ balances, deposits });
}
```

Why this is a problem:
- The route relies only on knowledge of a public wallet address.
- Public addresses are easy to scrape or infer from user interactions.
- Deposit history and operational balances are business-sensitive data.

Recommended Fix:
- Require authenticated wallet ownership, consistent with:
  - `app/api/transactions/route.ts`
  - `app/api/webhook/route.ts`
- Reuse the existing nonce-signature auth flow for this endpoint.

Mitigation:
- If full auth cannot be added immediately, reduce the response surface:
  - remove raw deposit history
  - return only coarse-grained balances
  - add stronger rate limiting and monitoring

### Priority Recommendation

Fix in this order:

1. `Q402-SEC-001` — entitlement consumption before relay viability is fully known
2. `Q402-SEC-002` — sandbox signed success webhooks
3. `Q402-SEC-003` — public balance/deposit enumeration

### Validation Notes

Local validation completed on the current snapshot:

- `npm run lint`
- `npm test` -> 155/155 passed
- `npm run build`

These checks show the codebase is functionally healthy, but they do not invalidate the security issues above because the problems are in business logic and trust boundaries rather than syntax or build correctness.

---

# Part 2 — 수정 결과

## 전체 요약

| Finding | 리뷰어 심각도 | 내부 심각도 | 조치 | 회귀 테스트 |
|---|---|---|---|---|
| Q402-SEC-001 | High | **High 수용** | 수표 순서 재배치 — `loadRelayerKey` 를 `decrementCredit` / `dailyCap` 앞으로 | [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts) · 9 assertion |
| Q402-SEC-002 | High | **Medium, priority High** | Sandbox 는 `getWebhookConfig` 조차 읽지 않도록 원천 차단 | 위 동일 파일 · 2 assertion |
| Q402-SEC-003 | Medium | **Low-Medium** | `requireAuth(address, nonce, sig)` 추가 + dashboard caller 업데이트 | [`__tests__/user-balance-auth.test.ts`](__tests__/user-balance-auth.test.ts) · 5 assertion |

**종합 검증:** `npx vitest run` → **169/169 통과** (기존 155 + 신규 14). `npm run lint` 청결. `npm run build` ✓ 4.3s.

---

## Q402-SEC-001 — Relay entitlements silent drain

### 네 지적 수용

정확하다. 기존 흐름은:

```
 1. rateLimit                ✓
 2. dailyCap (rateLimit)     차감됨
 3. chainCfg 검증
 4. auth impl lock 검증
 5. gas tank funding 검증
 6. decrementCredit          차감됨 ← 돈 냄
 7. loadRelayerKey           실패 → 503 반환
    ... 하지만 5번, 6번은 이미 차감됨
```

`RELAYER_PRIVATE_KEY` 오타·roll·accidental unset 시 **모든 호출자의 할당량이 조용히 소진**된다. 결제 고객 입장에서는 "내가 돈 냈는데 왜 크레딧이 줄지?" 상태. "High" 판정 수용.

### 선택한 수정 — 순서 재배치 (refund path 보존)

네가 제안한 두 가지 선택지 중 **순서 재배치** 를 골랐다. Refund path 중앙화는 이미 daily-cap ↔ decrementCredit 간에 구현돼 있어서 파괴하지 않는 편을 택했다.

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

핵심 신규 블록 (sandbox 는 skip):

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

> Note: `decrementCredit` 실패 시 "일일캡 refund" 경로는 보존. `dailyCap` → `decrementCredit` 순서 유지 — refund 경로 무결성도 테스트 6번으로 lock.

### 회귀 테스트 — [`__tests__/relay-ordering.test.ts`](__tests__/relay-ordering.test.ts)

Source-grep 방식. `route.ts` 내 landmark 문자열 offset 비교. 순서 역전 시 suite 실패:

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

미래 리팩터 PR 이 이 invariant 깨는 순간 CI 차단.

---

## Q402-SEC-002 — Sandbox signed fake success webhook

### 네 지적 수용 (+ 한 가지 다른 판단)

너의 fix 제안 세 개:
- A. `relay.sandbox_success` 같은 별도 이벤트 타입
- B. sandbox 전용 webhook secret
- C. sandbox webhook delivery 전면 차단

선택한 건 **C (전면 차단)**. 이유:
- sandbox 는 txHash 를 **fabricate** 한다. 어떤 event 타입으로 보내든 "서명 유효 + on-chain 부존재" 라는 기본 모순이 사라지지 않음. 통합 실수 여지가 남는다.
- sandbox 는 **자기 자신의 코드에서 호출을 쏴본다** 는 개발 편의용. webhook 의 주 용도(서버리스 회계) 와 의미가 겹치지 않음.
- 수정 비용 한 줄. 반면 A/B 는 새 코드 경로 · 새 secret storage · 새 DX 문서화 = 표면 증가.

내부 심각도는 **Medium** 으로 봤다. Sandbox 에서 실제 자금 이동이 없다는 점에서. 다만 **"HMAC 서명 유효성" 을 회계의 단일 신호로 쓰는 다운스트림** 을 가정해야 성립하므로 피해자 측 설계 의존. 수정 비용 0 이라 priority 는 High.

### 수정

[`app/api/relay/route.ts`](app/api/relay/route.ts):

```ts
// Q402-SEC-002: sandbox relays are simulated — no on-chain TX exists.
// Skip webhook dispatch entirely to prevent HMAC-signed "relay.success"
// events being forged through sandbox keys.
const webhookCfg = isSandbox ? null : await getWebhookConfig(keyRecord.address);
```

**의도적 선택** — `getWebhookConfig` **호출 자체를 차단**.

"dispatch 직전 isSandbox 체크" 패턴도 가능했지만, 후속 리팩터가 체크를 옮기거나 제거해도 suite 가 잡아주지 못함. "config read 조차 안 한다" 는 더 강한 invariant 이고, source-grep 으로 lock 하기도 쉽다.

### 회귀 테스트

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

첫 단언은 **정확한 ternary 패턴** 을 강제 — `isSandbox && ...` 변형도 통과 못 함. 두 번째는 과거 주석 재등장을 막고 새 주석이 `LIVE only` / `Q402-SEC-002` 마커를 담게 한다.

### 추가 조치 (네 제안 외)

릴리스 노트와 API 문서 양쪽에서 sandbox 가 webhook 을 쏘지 않음을 명시했다:

- README §20 보안 속성 표: "Sandbox 격리" 항목에 "웹훅 디스패치는 live-only (v1.17, Q402-SEC-002)" 추가
- README §25 Changelog v1.17 블록에 Q402-SEC-002 전체 근거 기술

---

## Q402-SEC-003 — Public user-balance enumeration

### 네 지적 수용 (+ 심각도 calibration 은 아래 약간 다름)

정확하다. `GET /api/gas-tank/user-balance?address=0x...` 가 unauthenticated. 주소만 알면 타 지갑의 체인별 가스 잔고 + 입금 txHash 이력 전부 JSON 으로 응답. 30 req/60s rate limit 만 있어서 스크래핑이 느릴 뿐 가능.

내부 심각도: **Low-Medium**. 근거:
- 원본 데이터는 `GASTANK_ADDRESS` 로 들어오는 on-chain transfer 로그로 **부분적으로 도출 가능** — 완전 비공개 자료는 아님.
- 다만 API 엔드포인트는 per-chain normalized JSON 으로 **마찰 없이** 제공했고, **address → Q402 customer** 매핑을 trivial 하게 만들어줬음.
- `/api/transactions`, `/api/webhook` 과 **일관되지 않았음** — 같은 API 표면의 다른 인증 모델은 공격 벡터이자 UX 혼란. 네가 쓴 "reuse the existing nonce-signature auth flow" 권고 그대로 수용.

### 선택한 수정 — Full auth (네가 권장한 primary path)

너의 primary fix 와 mitigation 중, **primary (requireAuth 전면 적용)** 를 선택. Mitigation (coarse balance · history 제거) 은 API 표면을 깎아내기만 할 뿐 enumeration 자체는 여전히 가능해서.

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

- 순서: rate limit → auth → data read. Auth 실패 시 data 접근 없음.
- per-IP rate limit 은 **defense in depth** 로 유지 (auth 우회 시도 부하 차단 + 네가 언급한 "stronger rate limiting" 권고 존중).
- `requireAuth()` 는 `/api/transactions`, `/api/webhook` 과 동일 모듈 — 세션 nonce 1h TTL, EIP-191 personal_sign.

### Dashboard caller 업데이트 — [`app/dashboard/page.tsx`](app/dashboard/page.tsx)

기존 (익명 호출):
```ts
const refreshUserBalance = useCallback((addr: string) => {
  fetch(`/api/gas-tank/user-balance?address=${addr}`) ...
}, []);
```

변경 (cached auth):
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

`getAuthCreds()` 는 sessionStorage 캐시를 쓰므로 **유저 지갑 팝업은 최초 1회**. 이후 폴링/새로고침에서는 재서명 요구 없음. `NONCE_EXPIRED` 수신 시 자동 캐시 invalidate. UX regression 없음.

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

## Severity calibration — 리뷰어 vs 내부

리뷰에서 High/High/Medium 이었는데 내부는 High/Medium/Low-Medium 로 봤다.

| Finding | 차이 이유 |
|---|---|
| SEC-001 | **일치**. 조용한 quota drain 은 신뢰 붕괴 + 환불 폭탄. 발동 조건 낮음. |
| SEC-002 | Sandbox 에서는 **실제 자금 이동이 없다**. 공격 성공해도 다운스트림 오염이 sandbox scope 이내. 다만 **"HMAC 서명 유효성" 이라는 단일 신호에 회계가 의존하는 시나리오** 를 가정해야 성립 → 피해자 측 설계 의존. 그래서 Medium. 수정 비용 0 이라 priority 는 High. |
| SEC-003 | 공개 블록 익스플로러 + `GASTANK_ADDRESS` 로 **부분적으로 같은 정보** 획득 가능. JSON API 가 한 발로 주는 편의성은 제거됐지만, "완전히 숨겨진 정보" 는 아님. 그래서 Low-Medium. 다만 `/api/transactions` 와의 **API 표면 일관성** 가치가 커서 수정. |

내가 calibration 너무 낮게 잡았으면 알려줘.

---

## 부수적으로 정리된 것들

- README §20 (보안) 에 **v1.17 보안 감사 이력** 섹션 추가 — 각 finding 원인·수정·회귀 테스트 링크.
- README §25 (Changelog) 에 **v1.17 (2026-04-18)** 블록 추가.
- README §9 (API Reference) 의 `/api/gas-tank/user-balance` 스펙 업데이트 — `?address&nonce&sig` 로 변경.
- 보안 속성 표 (§20) 에서 "API Key 소유권 증명" 행에 `user-balance` 추가, "Sandbox 격리" 행에 "웹훅 디스패치는 live-only (v1.17, Q402-SEC-002)" 주석.
- 세션 메모리 파일에 v1.17 마일스톤 기록.

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

**Test count:** 155 → 169 (신규 14). **Build:** ✓ 4.3s. **Lint:** clean.

세 finding 전부 반영 완료. 리포트 다시 한번 감사. 🙏
