# Q402 — 새 컴퓨터 셋업 가이드
> 최종 업데이트: 2026-03-30

새 컴퓨터에서 바로 작업 이어가기 위한 전체 가이드.

---

## 1. 레포 클론

```bash
# Q402 메인 앱 (Vercel 배포됨)
git clone https://github.com/bitgett/Q402-Institutional
cd Q402-Institutional
npm install

# 컨트랙트 배포 레포 (별도 압축파일로 제공)
# q402-avalanche.zip 압축 해제
```

---

## 2. 환경변수 설정

`Q402-Institutional/.env.local` 파일 생성:

```env
# 릴레이어 지갑 (가스 대납 주체)
RELAYER_PRIVATE_KEY=<DEPLOYER_PRIVATE_KEY — q402-avalanche/.env에 있음>

# 컨트랙트 주소
IMPLEMENTATION_CONTRACT=0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c
BNB_IMPLEMENTATION_CONTRACT=0x6cF4aD62C208b6494a55a1494D497713ba013dFa
ETH_IMPLEMENTATION_CONTRACT=0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD
XLAYER_IMPLEMENTATION_CONTRACT=0x8D854436ab0426F5BC6Cc70865C90576AD523E73
STABLE_IMPLEMENTATION_CONTRACT=0x2fb2B2D110b6c5664e701666B3741240242bf350

# Vercel KV (Vercel 대시보드에서 복사)
KV_REST_API_URL=
KV_REST_API_TOKEN=

# Admin
ADMIN_SECRET=
```

> **Vercel KV 값은 Vercel 대시보드 → Storage → Q402 KV에서 복사**

---

## 3. 로컬 실행

```bash
npm run dev
# → http://localhost:3000
```

---

## 4. 컨트랙트 배포 (새 체인 추가 시)

```bash
cd q402-avalanche/q402-avalanche
npm install

# .env에 DEPLOYER_PRIVATE_KEY 있는지 확인
cat .env

# 배포
npx hardhat run scripts/deploy.ts --network avalanche
npx hardhat run scripts/deploy-bnb.ts --network bnb
npx hardhat run scripts/deploy-eth.ts --network eth
npx hardhat run scripts/deploy-xlayer.ts --network xlayer
npx hardhat run scripts/deploy-stable.ts --network stable
```

---

## 5. 배포된 컨트랙트 현황

| Chain | Chain ID | 주소 | 가스 토큰 | 검증 |
|-------|----------|------|----------|------|
| Avalanche | 43114 | `0x96a8C74d95A35D0c14Ec60364c78ba6De99E9A4c` | AVAX | Routescan ✅ |
| BNB Chain | 56 | `0x6cF4aD62C208b6494a55a1494D497713ba013dFa` | BNB | Sourcify ✅ |
| Ethereum | 1 | `0x8E67a64989CFcb0C40556b13ea302709CCFD6AaD` | ETH | Sourcify ✅ |
| X Layer | 196 | `0x8D854436ab0426F5BC6Cc70865C90576AD523E73` | OKB | OKLink ✅ |
| Stable Mainnet | 988 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | USDT0 | 미검증 |
| Stable Testnet | 2201 | `0x2fb2B2D110b6c5664e701666B3741240242bf350` | USDT0 | 미검증 |

---

## 6. 릴레이어 지갑

| 항목 | 값 |
|------|----|
| 주소 | `0xfc77ff29178b7286a8ba703d7a70895ca74ff466` |
| 역할 | 모든 체인 가스 대납 (Gas Tank) |
| 프라이빗 키 | `q402-avalanche/.env`의 `DEPLOYER_PRIVATE_KEY` |

---

## 7. Vercel 배포

```bash
# Vercel CLI 설치
npm install -g vercel

# 프로젝트 링크
cd Q402-Institutional
vercel link --project q402-institutional --scope bitgett-7677s-projects --yes

# 환경변수 추가
echo "0x주소" | vercel env add STABLE_IMPLEMENTATION_CONTRACT production

# 배포는 git push로 자동
git push origin main
```

---

## 8. 현재 진행 중인 것

### Stable 파트너십 발표
- **담당자:** Eunice (@eunicecyl) — stable.xyz
- **발표일:** 2026-04-04 (금) 19:00 HKT
- **방식:** Quack AI Twitter 포스팅 → Stable RT/QT
- **Draft:** https://typefully.com/t/tObboj7
- **스펙 문서:** `Q402_STABLE_INTEGRATION.md`

### 남은 작업
- [ ] Stable 컨트랙트 Sourcify/Stablescan 검증
- [ ] Partnership Announcement 트위터 포스팅 (금요일)
- [ ] quackai.ai/q402 및 q402.quackai.ai 도메인 연결
- [ ] Stable 메인넷 Gas Tank 충전 (현재 0.12 USDT0)

---

## 9. 주요 URL

| 항목 | URL |
|------|-----|
| GitHub | https://github.com/bitgett/Q402-Institutional |
| Vercel (테스트) | https://q402-institutional.vercel.app |
| 공식 예정 | https://quackai.ai/q402 |
| Stable Explorer | https://stablescan.xyz |
| Stable Docs | https://docs.stable.xyz |

---

## 10. 관련 문서

| 파일 | 내용 |
|------|------|
| `Q402_IMPLEMENTATION.md` | 전체 구현 문서 (한국어) |
| `Q402_STABLE_INTEGRATION.md` | Stable 통합 스펙 (영어, 파트너 공유용) |
| `Q402_AVALANCHE_TECHNICAL_SPEC.md` | Avalanche 기술 스펙 (영어) |
| `README.md` | 프로젝트 소개 |
| `HANDOFF.md` | 이 문서 |
