'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, type ReactNode } from 'react';

/* ============================================================================
   Q402 by Quack AI - landing body, "keep-recolor" (depth pass)

   The REAL live hero (<Navbar/> + <Hero/>) is kept untouched. Below it sits the
   editorial body, scoped under .c1-root, recoloured to the live navy/yellow
   palette + a cyan trust accent.

   This pass trades the flat hairline-wireframe look for material depth:
   a living background (glows + faded grid), gap-separated panels with an inner
   top-highlight and soft shadow instead of shared 1px borders, a credibility
   stat band, capability/security/pricing/prompt CARDS, and pill section
   kickers with gradient titles. All CSS is scoped under .c1-root.
   ========================================================================== */

// inv = the logo is light-coloured (white/grey), so invert it to show on a white chip
const AI_CLIENTS = [
  { name: 'Claude', src: '/logos/claude.svg' },
  { name: 'Codex', src: '/logos/codex.svg' },
  { name: 'Cursor', src: '/logos/cursor.svg', inv: true },
  { name: 'Cline', src: '/logos/cline.svg', inv: true },
  { name: 'Copilot', src: '/logos/copilot.jpg' },
  { name: 'Hermes', src: '/logos/hermes.jpg' },
];

const CHAINS = [
  { name: 'BNB Chain', src: '/bnb.png',       color: '#F0B90B' },
  { name: 'Ethereum',  src: '/eth.png',       color: '#627EEA' },
  { name: 'Mantle',    src: '/mantle.png',    color: '#D8D8D8' },
  { name: 'Avalanche', src: '/avax.png',      color: '#E84142' },
  { name: 'Injective', src: '/injective.png', color: '#0082FA' },
  { name: 'X Layer',   src: '/xlayer.png',    color: '#CFCFCF' },
  { name: 'Stable',    src: '/stable.jpg',    color: '#4AE54A' },
  { name: 'Monad',     src: '/monad.png',     color: '#836EF9' },
  { name: 'Scroll',    src: '/scroll.png',    color: '#EEB431' },
  { name: 'Arbitrum',  src: '/arbitrum.png',  color: '#28A0F0' },
];

const MARQUEE = [
  ...CHAINS.map((c) => ({ ...c, status: 'Mainnet Live' })),
  { name: 'USDC',  src: '/usdc.svg',  color: '#2775CA', status: 'Stablecoin' },
  { name: 'USDT',  src: '/usdt.svg',  color: '#26A17B', status: 'Stablecoin' },
  { name: 'RLUSD', src: '/rlusd.png', color: '#0085FF', status: 'Stablecoin' },
];

// §05 comparison table rows
const VERSUS = [
  { d: 'Off-chain mempool', a: 'Bundler required',     b: 'None' },
  { d: 'Account type',      a: 'Smart account',        b: 'Vanilla EOA' },
  { d: 'Gas sponsorship',   a: 'Per-chain paymaster',  b: 'One Gas Tank, 10 chains' },
  { d: 'Install',           a: 'Account migration',    b: 'EIP-7702, per transaction' },
  { d: 'Moving parts',      a: '7',                    b: '2' },
];

const USE_CASES = [
  {
    key: 'ai', label: 'AI Agents', tag: 'NEW',
    hook: 'Tell your agent. It pays.',
    body: 'Claude, Codex, Cursor, Cline, or your own agent call Q402 over MCP. 2,000 free sponsored BNB transactions to start, then a Multichain Gas Tank when you scale. 24 tools, a signed receipt every settlement, sandbox-safe.',
    chips: ['24 MCP tools', 'Batch × 20', 'Trust Receipts'],
  },
  {
    key: 'defi', label: 'DeFi', tag: '',
    hook: 'Stop making them buy ETH first.',
    body: 'First swap, first stake, first vote. One signature, no gas chase. Your treasury covers the relay, so a day-1 wallet never dead-ends on “you need gas first.”',
    chips: ['One signature', 'Zero top-up', 'Any EOA'],
    code: [
      { k: 'comment', t: '// New user joins your dApp. Already has USDC. No ETH.' },
      { k: 'code', t: 'await q402.pay({ to: protocol, amount: "100", token: "USDC", chain: "eth" })' },
      { k: 'ok', t: '→ Staked. One signature. No top-up step.' },
    ],
  },
  {
    key: 'nft', label: 'NFT Drops', tag: '',
    hook: 'Collectors touch USDC. You touch the chain.',
    body: 'Stablecoin-priced drops where the mint gas hits your Gas Tank, not the collector’s. Allowlist holders mint without scrambling for L2 gas.',
    chips: ['USDC-priced', 'No L2 top-up', 'Allowlist-safe'],
    code: [
      { k: 'comment', t: '// Mint priced at 25 USDC; you cover the chain gas.' },
      { k: 'code', t: 'await q402.pay({ to: mintContract, amount: "25", token: "USDC", chain: "bnb" })' },
      { k: 'ok', t: '→ Minted. Allowlist decremented. Gas debited from your tank.' },
    ],
  },
  {
    key: 'gaming', label: 'Gaming', tag: '',
    hook: '$0.05 swords. Sub-cent settle.',
    body: 'Price items at chain economics, not gas economics. Batch a tournament’s payouts in one signed call, on any of the 10 chains.',
    chips: ['Batch × 20', 'Any chain', 'Sub-cent fees'],
    code: [
      { k: 'comment', t: '// Tournament ends. Pay 20 winners in one call.' },
      { k: 'code', t: 'await q402.batchPay({ token: "USDT", recipients: winners })' },
      { k: 'ok', t: '→ 20/20 sent · sub-cent fee · gas debited once' },
    ],
  },
  {
    key: 'b2b', label: 'B2B Payments', tag: '',
    hook: 'Invoices clear in 400ms.',
    body: 'USDC, USDT, or RLUSD between businesses, each with an ECDSA-signed Trust Receipt. Your accountant gets a verifiable receipt chain, not a CSV.',
    chips: ['10-chain', 'Trust Receipts', '~400ms'],
    code: [
      { k: 'comment', t: '// Settle vendor invoice + fetch the receipt.' },
      { k: 'code', t: 'const { receiptId } = await q402.pay({ to: vendor, amount: "12500", token: "USDC" })' },
      { k: 'code', t: 'const receipt = await q402.receipt(receiptId)  // ECDSA-verifiable' },
      { k: 'ok', t: '→ Settled · receipt rct_8f2a… (signed by relayer EOA)' },
    ],
  },
  {
    key: 'wallets', label: 'Wallets', tag: '',
    hook: 'Plug it in. Gas disappears.',
    body: 'Privy, Dynamic, Magic: plain EOAs delegate via EIP-7702. No 4337 bundler, no smart-account migration, no per-chain paymaster.',
    chips: ['No 4337', 'Any embedded wallet', 'EIP-7702'],
    code: [
      { k: 'comment', t: '// Pair Q402 with your embedded wallet, a vanilla EOA.' },
      { k: 'code', t: "import { Q402Client } from '@quackai/q402-sdk'" },
      { k: 'code', t: 'const q402 = new Q402Client({ apiKey, signer: privy.signer })' },
      { k: 'ok', t: '→ EIP-7702 delegation installed transaction-by-transaction' },
    ],
  },
];

const SECURITY = [
  {
    n: '01', t: 'Non-custodial',
    body: 'Users sign off-chain. Keys never leave the wallet; Q402 never holds funds or keys.',
  },
  {
    n: '02', t: 'EIP-7702 owner-binding',
    body: 'A delegated authorization can only move the signer’s own balance, bound to the owner’s address.',
  },
  {
    n: '03', t: 'Sandbox by default',
    body: 'q402_test_ keys fabricate settlements safely. No real funds, no real webhooks.',
  },
  {
    n: '04', t: 'Fully on-chain verifiable',
    body: 'One transaction, end to end. Confirm any settlement on BscScan, Etherscan, or Snowtrace.',
  },
];

// laid out as an asymmetric bento (areas map to .c1-bento grid-template-areas)
const CAPABILITIES = [
  { t: 'Multichain Gas Tank', s: 'One pre-funded tank sponsors gas on all 10 chains. Top up once, your agents spend anywhere.', tag: 'Live', area: 'tank', feature: true },
  { t: 'Aave V3 yield routing', s: 'Park idle balances into Aave V3 from an agent prompt.', tag: 'Live', logo: '/aave.svg', area: 'aave' },
  { t: 'CCIP cross-chain bridge', s: 'Move value across ETH / AVAX / ARB via Chainlink CCIP.', tag: 'Live', logo: '/link.jpg', area: 'ccip' },
  { t: 'Agentic Wallets', s: 'Multi-wallet pipelines with per-wallet daily-spend caps.', tag: 'Live', area: 'wallet' },
  { t: 'Recurring payments', s: 'Scheduled fires with a cancel window before each run.', tag: 'Live', area: 'recur' },
  { t: 'Batch payouts ≤ 20', s: 'Up to 20 recipients in one signed call.', tag: 'Live', area: 'batch' },
  { t: 'Morpho vault routing', s: 'Sweep idle USDC into the highest-yielding vault.', tag: 'Roadmap', area: 'morpho' },
];

const PRICING = [
  {
    name: 'Free Trial', price: '$0', period: 'per 30 days · no card',
    desc: 'Start in one signature. Email or wallet, no payment up-front.',
    feats: ['2,000 sponsored transactions', 'BNB Chain · USDC + USDT', 'Live + sandbox API keys', 'Q402 covers the gas'],
    cta: 'Start free trial', href: '/event', accent: true,
  },
  {
    name: 'Starter', price: '$29', period: 'per 30-day access',
    desc: 'For indie developers and early-stage projects.',
    feats: ['500 sponsored transactions', 'All 10 EVM chains', 'Full API access', 'Community support'],
    cta: 'Get started', href: '/payment',
  },
  {
    name: 'Pro', price: '$149', period: 'per 30-day access',
    desc: 'For growing products with real users.',
    feats: ['10,000 sponsored transactions', 'All 10 EVM chains', 'Full API access', 'Email support'],
    cta: 'Get started', href: '/payment', popular: true,
  },
  {
    name: 'Scale', price: '$449', period: 'per 30-day access',
    desc: 'For high-throughput DeFi applications.',
    feats: ['50,000 sponsored transactions', 'All 10 EVM chains', 'API access + webhooks', 'Priority support'],
    cta: 'Get started', href: '/payment',
  },
  {
    name: 'Enterprise', price: '$1,999', period: 'per 30-day access',
    desc: 'For mission-critical apps at any scale.',
    feats: ['500,000 sponsored transactions', 'All 10 EVM chains', 'SLA guarantee (99.9% uptime)', 'Dedicated account manager'],
    cta: 'Get started', href: '/payment',
  },
];

/* --- scroll reveal hook --------------------------------------------------- */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const els = root.querySelectorAll('[data-reveal]');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('c1-in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -8% 0px' }
    );
    els.forEach((el: Element) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return ref;
}

/* --- section header (pill kicker + gradient title) ------------------------ */
function Shead({ index, kicker, live, children, sub }: {
  index: string; kicker: string; live?: boolean; children: ReactNode; sub?: ReactNode;
}) {
  return (
    <div className="c1-shead" data-reveal>
      <span className="c1-kick">
        {live ? <span className="c1-kick-live" /> : <span className="c1-kick-n">{index}</span>}
        {kicker}
      </span>
      <h2 className="c1-stitle">{children}</h2>
      {sub ? <p className="c1-sub">{sub}</p> : null}
    </div>
  );
}

/* --- mainnet-live chain marquee (revived) -------------------------------- */
function ChainMarquee() {
  const items = [...MARQUEE, ...MARQUEE];
  return (
    <div className="c1-mq-wrap">
      <p className="c1-mq-eyebrow">Mainnet Live · Multi-chain EVM</p>
      <div className="marquee-track">
        <div className="c1-mq-row animate-marquee">
          {items.map((m, i) => (
            <div className="c1-mq-card" key={i}>
              <img src={m.src} alt={m.name} className="c1-mq-logo" />
              <div className="c1-mq-meta">
                <span className="c1-mq-name">{m.name}</span>
                <span className="c1-mq-status" style={{ color: m.color }}>{m.status}</span>
              </div>
              <span className="c1-mq-dot" style={{ background: m.color, boxShadow: `0 0 7px ${m.color}` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --- line icons (scale crisply, inherit currentColor) --------------------- */
const IconWallet = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2.5" y="5.5" width="19" height="14" rx="2.5" />
    <path d="M2.5 10h19" />
    <circle cx="17" cy="14.7" r="1.25" fill="currentColor" stroke="none" />
  </svg>
);
const IconRelay = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="2.6" />
    <path d="M12 4.4v3.2M12 16.4v3.2M4.4 12h3.2M16.4 12h3.2" />
    <path d="M6.8 6.8l2.2 2.2M17.2 6.8l-2.2 2.2M6.8 17.2l2.2-2.2M17.2 17.2l-2.2-2.2" opacity=".55" />
  </svg>
);
const IconReceive = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="8.5" r="4.3" />
    <path d="M12 6.6v3.8M10.4 8.9L12 10.5l1.6-1.6" />
    <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
  </svg>
);
const IconSeal = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="8" />
    <path d="M8.4 12.2l2.5 2.5 4.6-5.1" />
  </svg>
);

/* --- per-use-case line illustrations (no emoji) -------------------------- */
function UseIcon({ name }: { name: string }) {
  const p = {
    width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  };
  switch (name) {
    case 'ai': // agent: chat bubble + spark
      return (
        <svg {...p}>
          <path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16H9l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 5Z" />
          <path d="M12 8l.85 2.15L15 11l-2.15.85L12 14l-.85-2.15L9 11l2.15-.85L12 8Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'defi': // swap arrows
      return (
        <svg {...p}>
          <path d="M4 8.5h13M14 5.5l3 3-3 3" />
          <path d="M20 15.5H7M10 18.5l-3-3 3-3" />
        </svg>
      );
    case 'nft': // image / gallery frame
      return (
        <svg {...p}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="9.5" r="1.5" />
          <path d="M4 17l4.8-4.5 3 2.8L16 10l4 4.4" />
        </svg>
      );
    case 'gaming': // gamepad
      return (
        <svg {...p}>
          <rect x="2.5" y="7.5" width="19" height="9" rx="4.5" />
          <path d="M7 10.6v2.8M5.6 12h2.8" />
          <circle cx="15.8" cy="11.2" r="1" fill="currentColor" stroke="none" />
          <circle cx="18" cy="13.2" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'b2b': // invoice + check
      return (
        <svg {...p}>
          <path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
          <path d="M13.5 3.5V8h4" />
          <path d="M8.5 13l1.4 1.4 3-3" />
          <path d="M8.5 17.5h7" />
        </svg>
      );
    case 'wallets': // wallet
    default:
      return (
        <svg {...p}>
          <rect x="3" y="6" width="18" height="13" rx="2.5" />
          <path d="M3 10h18" />
          <circle cx="16.5" cy="14.6" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

/* --- MCP client logo: uniform white chip; hides itself if file is missing - */
function ClientLogo({ src, name, inv }: { src: string; name: string; inv?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // an image that failed during SSR/initial load won't re-fire onError after
    // hydration, so hide the whole chip via the DOM if it already failed to decode
    const img = ref.current?.querySelector('img');
    if (img && img.complete && img.naturalWidth === 0 && ref.current) ref.current.style.display = 'none';
  }, []);
  return (
    <span ref={ref} className="c1-use-clogo" title={name}>
      <img
        src={src}
        alt={name}
        className={inv ? 'c1-inv' : undefined}
        onError={() => { if (ref.current) ref.current.style.display = 'none'; }}
      />
    </span>
  );
}

/* --- the gasless mechanism, drawn (A → relayer → recipient) --------------- */
function FlowDiagram() {
  return (
    <>
      <div className="c1-flow" data-reveal>
        <div className="c1-fnode">
          <span className="c1-fnode-ico c1-ico2"><IconWallet /></span>
          <div>
            <div className="c1-fnode-tag c1-acc2">A · User</div>
            <div className="c1-fnode-t">Signs, off-chain</div>
            <div className="c1-fnode-s">One EIP-712 signature. No gas, no chain call, any EVM wallet.</div>
          </div>
          <div className="c1-fnode-addr">0x71C7…976F</div>
        </div>

        <div className="c1-flink c1-flink-1">
          <div className="c1-flink-top">signature</div>
          <div className="c1-flink-line"><span className="c1-flink-dot" /></div>
          <div className="c1-flink-bot"><span className="c1-flink-badge">$0 gas</span></div>
        </div>

        <div className="c1-fnode c1-fnode-mid">
          <span className="c1-fnode-ico"><IconRelay /></span>
          <div>
            <div className="c1-fnode-tag">B · Q402 relayer</div>
            <div className="c1-fnode-t">Relays it on-chain</div>
            <div className="c1-fnode-s">One transaction, gas sponsored. Moves the signer’s balance, nothing else.</div>
          </div>
          <div className="c1-fnode-addr c1-acc">pays the gas →</div>
        </div>

        <div className="c1-flink c1-flink-2">
          <div className="c1-flink-top">1 transaction</div>
          <div className="c1-flink-line"><span className="c1-flink-dot" /></div>
          <div className="c1-flink-bot"><span className="c1-flink-badge">on-chain</span></div>
        </div>

        <div className="c1-fnode">
          <span className="c1-fnode-ico"><IconReceive /></span>
          <div>
            <div className="c1-fnode-tag">C · Recipient</div>
            <div className="c1-fnode-t">Gets paid</div>
            <div className="c1-fnode-s">USDC lands in one block. Fully on-chain, anyone can verify.</div>
          </div>
          <div className="c1-fnode-addr"><img src="/usdc.svg" alt="" className="c1-inline-coin" />+ 50.00 USDC</div>
        </div>
      </div>
      <p className="c1-flow-cap" data-reveal>
        <b>One signature in, one transaction out.</b> The user never touches gas.
      </p>
    </>
  );
}

/* --- ERC-4337 vs Q402, as a scannable comparison table ------------------- */
function VersusTable() {
  return (
    <div className="c1-cmp" data-reveal>
      <div className="c1-cmp-row c1-cmp-head">
        <span className="c1-cmp-d" />
        <span className="c1-cmp-a">ERC-4337</span>
        <span className="c1-cmp-b"><span className="c1-mark c1-mark-sm"><i /></span><span className="c1-q">Q402</span></span>
      </div>
      {VERSUS.map((r) => (
        <div className="c1-cmp-row" key={r.d}>
          <span className="c1-cmp-d">{r.d}</span>
          <span className="c1-cmp-a">{r.a}</span>
          <span className="c1-cmp-b"><span className="c1-cmp-check">✓</span>{r.b}</span>
        </div>
      ))}
    </div>
  );
}

/* --- the Trust Receipt as an actual signed receipt ------------------------ */
function ReceiptCard() {
  const rows: [string, string][] = [
    ['Amount', '50.00 USDC'],
    ['Chain', 'BNB Chain'],
    ['Payer gas', '$0.000000'],
    ['Settled', '412 ms'],
    ['Signer', 'relayer EOA 0xfc77…f466'],
  ];
  return (
    <div className="c1-rcpt-paper" data-reveal>
      <div className="c1-rcpt-top">
        <span className="c1-rcpt-brand">
          <span className="c1-mark"><i /></span>
          <span className="c1-q">Q402</span>
          <span className="c1-rcpt-doc">Trust Receipt</span>
        </span>
        <span className="c1-rcpt-id">rct_8f2a…d91e</span>
      </div>
      <div className="c1-rcpt-rows">
        {rows.map(([k, v]) => (
          <div className="c1-rcpt-row" key={k}>
            <span>{k}</span>
            <span className="c1-rcpt-v">
              {k === 'Amount' ? <img src="/usdc.svg" alt="" className="c1-inline-coin" /> : null}{v}
            </span>
          </div>
        ))}
      </div>
      <div className="c1-rcpt-perf" />
      <div className="c1-rcpt-sig">
        <span className="c1-rcpt-seal"><IconSeal /></span>
        <div>
          <div className="c1-rcpt-sigt">ECDSA signature verified</div>
          <div className="c1-rcpt-sigs">Recovered from on-chain state. No Q402 API call.</div>
        </div>
      </div>
    </div>
  );
}

export default function LandingBody() {
  const rootRef = useReveal();

  return (
    <div ref={rootRef} className="c1-root">
        <div className="c1-bg" aria-hidden>
          <span className="c1-glow c1-glow-y" />
          <span className="c1-glow c1-glow-c" />
          <span className="c1-gridlines" />
        </div>

        <style>{`
.c1-root{
  --bg:#070C16;
  --ink:#ffffff;
  --mut:rgba(255,255,255,.60);
  --mut2:rgba(255,255,255,.38);
  --line:rgba(255,255,255,.09);
  --hair:rgba(255,255,255,.06);
  --acc:#F5C518;
  --acc-h:#FBD13A;
  --acc2:#5BC8FA;
  --disp:var(--font-display),'Bricolage Grotesque','Inter',system-ui,sans-serif;
  --body:var(--font-poppins),'Poppins',system-ui,sans-serif;
  --mono:var(--font-mono),'JetBrains Mono',ui-monospace,monospace;
  --panel:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012));
  --panel-sh:inset 0 1px 0 rgba(255,255,255,.07),0 24px 50px -38px rgba(0,0,0,.95);
  position:relative;
  background:var(--bg);
  color:var(--ink);
  font-family:var(--body);
  font-weight:400;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
  letter-spacing:.005em;
  overflow:hidden;
}
.c1-root *{box-sizing:border-box;}
.c1-root a{color:inherit;text-decoration:none;}
.c1-root button{font-family:inherit;cursor:pointer;}

/* ---- living background ---- */
.c1-bg{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;}
.c1-glow{position:absolute;border-radius:50%;filter:blur(40px);opacity:.5;}
.c1-glow-y{width:760px;height:520px;top:-180px;left:-120px;
  background:radial-gradient(closest-side,rgba(245,197,24,.16),transparent 70%);}
.c1-glow-c{width:720px;height:560px;top:520px;right:-200px;
  background:radial-gradient(closest-side,rgba(91,200,250,.12),transparent 70%);}
.c1-gridlines{position:absolute;inset:0;
  background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
  background-size:60px 60px;
  -webkit-mask-image:radial-gradient(130% 70% at 50% -5%,#000 25%,transparent 72%);
  mask-image:radial-gradient(130% 70% at 50% -5%,#000 25%,transparent 72%);}

/* ---- layout shell ---- */
.c1-wrap{max-width:1280px;margin:0 auto;padding:0 28px;position:relative;z-index:1;}
@media(max-width:520px){.c1-wrap{padding:0 18px;}}
.c1-section{position:relative;z-index:1;padding:62px 0;}
.c1-section-first{padding:46px 0 14px;}
@media(max-width:760px){.c1-section{padding:46px 0;}.c1-section-first{padding:30px 0 8px;}}

/* ---- reusable panel ---- */
.c1-panel{border:1px solid var(--line);border-radius:18px;background:var(--panel);
  box-shadow:var(--panel-sh);}

/* ---- section header ---- */
.c1-shead{max-width:none;}
.c1-kick{display:inline-flex;align-items:center;gap:9px;font-family:var(--disp);font-weight:600;
  font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--mut);
  border:1px solid var(--line);border-radius:999px;padding:7px 14px;
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.01));}
.c1-kick-n{font-family:var(--mono);font-weight:700;font-size:11px;color:var(--acc);letter-spacing:.04em;}
.c1-kick-live{width:7px;height:7px;border-radius:50%;background:var(--acc);
  box-shadow:0 0 0 0 rgba(245,197,24,.5);animation:c1pulse 2.4s infinite;}
.c1-stitle{font-family:var(--disp);font-weight:700;white-space:nowrap;
  font-size:clamp(25px,3.4vw,42px);line-height:1.04;letter-spacing:-.038em;
  margin:18px 0 14px;
  background:linear-gradient(180deg,#fff 34%,rgba(255,255,255,.62));
  -webkit-background-clip:text;background-clip:text;color:transparent;}
@media(max-width:560px){.c1-stitle{white-space:normal;}}
.c1-stitle .c1-acc{-webkit-text-fill-color:var(--acc);color:var(--acc);}
.c1-stitle .c1-acc2{-webkit-text-fill-color:var(--acc2);color:var(--acc2);}
.c1-sub{color:var(--mut);font-size:clamp(15px,1.5vw,16.5px);max-width:none;margin:0;}

/* reveal */
.c1-root [data-reveal]{opacity:0;transform:translateY(20px);
  transition:opacity .7s cubic-bezier(.16,1,.3,1),transform .7s cubic-bezier(.16,1,.3,1);}
.c1-root [data-reveal].c1-in{opacity:1;transform:none;}
@media(prefers-reduced-motion:reduce){.c1-root [data-reveal]{opacity:1;transform:none;}}

.c1-acc{color:var(--acc);}
.c1-acc2{color:var(--acc2);}
.c1-dot{width:6px;height:6px;border-radius:50%;display:inline-block;}
.c1-dot-live{background:var(--acc);box-shadow:0 0 0 0 rgba(245,197,24,.5);animation:c1pulse 2.4s infinite;}
@keyframes c1pulse{0%{box-shadow:0 0 0 0 rgba(245,197,24,.45);}70%{box-shadow:0 0 0 7px rgba(245,197,24,0);}100%{box-shadow:0 0 0 0 rgba(245,197,24,0);}}

/* ---- buttons ---- */
.c1-btn{font-family:var(--disp);font-weight:700;font-size:13.5px;letter-spacing:.01em;
  display:inline-flex;align-items:center;gap:8px;padding:11px 19px;border-radius:10px;
  transition:transform .15s,box-shadow .2s,background .2s,border-color .2s,color .2s;}
.c1-btn-acc{background:linear-gradient(180deg,var(--acc-h),var(--acc));color:#0A0F1C;
  box-shadow:0 10px 26px -10px rgba(245,197,24,.6);}
.c1-btn-acc:hover{transform:translateY(-1px);box-shadow:0 14px 32px -10px rgba(245,197,24,.75);}
.c1-btn-out{border:1px solid var(--line);color:var(--ink);
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.01));}
.c1-btn-out:hover{border-color:rgba(245,197,24,.5);color:var(--acc);transform:translateY(-1px);}
.c1-arrow{transition:transform .2s;}
.c1-btn:hover .c1-arrow{transform:translateX(3px);}
.c1-cta{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:30px;}
.c1-cta-lg{padding:14px 24px;font-size:14px;}

/* brand mark */
.c1-brand{display:flex;align-items:center;gap:11px;}
.c1-mark{width:28px;height:28px;border-radius:6px;background:var(--acc);
  display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px rgba(245,197,24,.35);}
.c1-mark i{width:12px;height:12px;background:rgba(11,18,32,.9);border-radius:2px;}
.c1-mark-sm{width:20px;height:20px;border-radius:5px;box-shadow:0 0 8px rgba(245,197,24,.3);}
.c1-mark-sm i{width:8px;height:8px;}
.c1-word{font-family:var(--disp);font-weight:700;font-size:18px;letter-spacing:-.02em;}
.c1-byq{color:var(--mut);font-size:12px;letter-spacing:.02em;}
@media(max-width:520px){.c1-byq{display:none;}}

/* inline token coin (used in the flow node + receipt amount) */
.c1-inline-coin{width:15px;height:15px;border-radius:50%;object-fit:cover;
  display:inline-block;vertical-align:-2px;margin-right:6px;}

/* ===== CHAIN MARQUEE (mainnet-live strip) ===== */
.c1-mq-eyebrow{text-align:center;color:var(--mut2);font-family:var(--disp);font-weight:600;
  font-size:11px;letter-spacing:.28em;text-transform:uppercase;margin:0 0 22px;}
.c1-mq-row{display:flex;gap:14px;width:max-content;}
.c1-mq-card{display:inline-flex;align-items:center;gap:12px;flex-shrink:0;
  border:1px solid var(--line);border-radius:14px;padding:13px 18px;
  background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012));}
.c1-mq-logo{width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0;}
.c1-mq-meta{display:flex;flex-direction:column;gap:3px;}
.c1-mq-name{font-family:var(--disp);font-weight:600;font-size:14px;color:var(--ink);white-space:nowrap;}
.c1-mq-status{font-family:var(--disp);font-weight:700;font-size:9px;letter-spacing:.16em;
  text-transform:uppercase;white-space:nowrap;}
.c1-mq-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;margin-left:2px;}

/* ===== USE CASES - hook-first grid ===== */
.c1-uses{display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:1fr;gap:14px;margin-top:26px;}
@media(max-width:860px){.c1-uses{grid-template-columns:repeat(2,1fr);}}
@media(max-width:560px){.c1-uses{grid-template-columns:1fr;}}
.c1-use{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:16px;
  background:var(--panel);box-shadow:var(--panel-sh);padding:24px;transition:transform .18s,border-color .2s;}
.c1-use:hover{transform:translateY(-4px);border-color:rgba(245,197,24,.32);}
.c1-use:hover .c1-use-ico{transform:scale(1.06);border-color:rgba(245,197,24,.5);}
.c1-use-lead{background:linear-gradient(160deg,rgba(245,197,24,.10),rgba(245,197,24,.02));
  border-color:rgba(245,197,24,.3);}
.c1-use-head{display:flex;align-items:center;gap:13px;margin-bottom:20px;}
.c1-use-ico{width:48px;height:48px;flex-shrink:0;border-radius:13px;border:1px solid var(--line);
  display:flex;align-items:center;justify-content:center;color:var(--acc);background:rgba(245,197,24,.06);
  transition:transform .18s,border-color .2s;}
.c1-use-lead .c1-use-ico{color:var(--acc2);border-color:rgba(91,200,250,.28);background:rgba(91,200,250,.06);}
.c1-use-cat{font-family:var(--disp);font-weight:600;font-size:11px;letter-spacing:.18em;text-transform:uppercase;
  color:var(--acc);display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;}
.c1-use-new{font-family:var(--disp);font-weight:700;font-size:8px;letter-spacing:.14em;color:var(--acc);
  border:1px solid var(--acc);border-radius:4px;padding:1px 5px;}
.c1-use-hook{font-family:var(--disp);font-weight:700;font-size:clamp(20px,1.9vw,24px);letter-spacing:-.025em;
  line-height:1.12;margin:0 0 22px;color:var(--ink);}
.c1-use-foot{display:flex;flex-direction:column;gap:13px;margin-top:auto;}
.c1-use-chips{display:flex;flex-wrap:wrap;gap:7px;}
.c1-chip{font-family:var(--disp);font-weight:500;font-size:10.5px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--mut);border:1px solid var(--line);border-radius:999px;
  padding:5px 11px;background:rgba(255,255,255,.02);}
.c1-use-mcp{padding-top:13px;border-top:1px solid var(--hair);}
.c1-use-clients{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.c1-use-clogo{width:30px;height:30px;flex-shrink:0;border-radius:8px;background:#fff;overflow:hidden;
  display:inline-flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.35);}
.c1-use-clogo img{width:100%;height:100%;object-fit:contain;padding:4px;}
.c1-use-clogo img.c1-inv{filter:invert(1);}
.c1-use-more{display:block;margin-top:10px;font-size:11px;color:var(--mut2);line-height:1.5;}

/* ===== CAPABILITIES - asymmetric bento ===== */
.c1-bento{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:26px;
  grid-template-areas:
    "tank tank aave ccip"
    "tank tank wallet recur"
    "batch batch morpho morpho";}
@media(max-width:860px){.c1-bento{grid-template-columns:repeat(2,1fr);
  grid-template-areas:
    "tank tank"
    "aave ccip"
    "wallet recur"
    "batch batch"
    "morpho morpho";}}
@media(max-width:560px){.c1-bento{grid-template-columns:1fr;grid-template-areas:none;}}
.c1-bento-tile{display:flex;flex-direction:column;justify-content:space-between;gap:24px;
  border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:var(--panel-sh);
  padding:20px;min-height:138px;transition:transform .18s,border-color .2s;}
@media(max-width:560px){.c1-bento-tile{grid-area:auto !important;}}
.c1-bento-tile:hover{transform:translateY(-3px);border-color:rgba(245,197,24,.3);}
.c1-bento-top{display:flex;align-items:center;gap:10px;}
.c1-bento-top .c1-tag{margin-left:auto;}
.c1-bento-t{font-family:var(--disp);font-weight:700;font-size:16px;letter-spacing:-.02em;margin-bottom:6px;}
.c1-bento-s{color:var(--mut);font-size:13px;line-height:1.5;}
.c1-bento-feature{padding:30px;position:relative;overflow:hidden;
  background:linear-gradient(160deg,rgba(245,197,24,.12),rgba(245,197,24,.02));
  border-color:rgba(245,197,24,.32);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 30px 60px -34px rgba(245,197,24,.4);}
.c1-bento-chains{display:flex;flex-wrap:wrap;gap:7px;margin-top:20px;}
.c1-bento-chain{width:28px;height:28px;border-radius:50%;object-fit:cover;
  border:1px solid var(--line);background:rgba(255,255,255,.04);}
.c1-bento-feature .c1-bento-t{font-size:clamp(22px,2.3vw,29px);margin-bottom:10px;}
.c1-bento-feature .c1-bento-s{font-size:14.5px;max-width:34ch;color:rgba(255,255,255,.72);}
.c1-cap-logo{width:24px;height:24px;border-radius:6px;object-fit:contain;flex-shrink:0;
  background:rgba(255,255,255,.06);padding:2px;}
.c1-tag{font-family:var(--disp);font-weight:600;font-size:10px;letter-spacing:.16em;text-transform:uppercase;
  padding:4px 9px;border-radius:999px;border:1px solid var(--line);color:var(--mut2);background:rgba(255,255,255,.02);}
.c1-tag-live{color:var(--acc);border-color:rgba(245,197,24,.35);background:rgba(245,197,24,.06);}

/* ===== TRUST & SECURITY - split: numbered points + receipt visual ===== */
.c1-trust{display:grid;grid-template-columns:1fr 1.05fr;gap:44px;margin-top:26px;align-items:start;}
@media(max-width:820px){.c1-trust{grid-template-columns:1fr;gap:30px;}}
.c1-trust-points{display:flex;flex-direction:column;}
.c1-trust-row{display:grid;grid-template-columns:auto 1fr;gap:16px;padding:16px 0;border-top:1px solid var(--hair);}
.c1-trust-row:first-child{border-top:none;padding-top:0;}
.c1-trust-n{font-family:var(--mono);font-weight:700;font-size:12px;color:var(--acc2);padding-top:3px;}
.c1-trust-t{font-family:var(--disp);font-weight:700;font-size:16px;letter-spacing:-.02em;margin-bottom:5px;}
.c1-trust-b{color:var(--mut);font-size:13.5px;line-height:1.55;max-width:46ch;}


/* ===== PRICING (cards) ===== */
.c1-price{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:26px;align-items:stretch;}
@media(max-width:1024px){.c1-price{grid-template-columns:repeat(2,1fr);}}
@media(max-width:520px){.c1-price{grid-template-columns:1fr;}}
.c1-tier{padding:24px 20px;border-radius:16px;border:1px solid var(--line);background:var(--panel);
  box-shadow:var(--panel-sh);display:flex;flex-direction:column;min-height:360px;position:relative;
  transition:transform .18s,border-color .2s;}
.c1-tier:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.2);}
.c1-tier-pop{border-color:rgba(245,197,24,.45);
  background:linear-gradient(180deg,rgba(245,197,24,.10),rgba(245,197,24,.02));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 30px 60px -28px rgba(245,197,24,.42);}
@media(min-width:1025px){.c1-tier-pop{transform:translateY(-8px);}.c1-tier-pop:hover{transform:translateY(-11px);}}
.c1-tier-flag{position:absolute;top:-10px;left:50%;transform:translateX(-50%);
  font-family:var(--disp);font-weight:700;font-size:9px;letter-spacing:.18em;text-transform:uppercase;
  color:#0A0F1C;background:linear-gradient(180deg,var(--acc-h),var(--acc));border-radius:999px;
  padding:4px 12px;box-shadow:0 8px 20px -8px rgba(245,197,24,.6);white-space:nowrap;}
.c1-tier-name{font-family:var(--disp);font-weight:600;font-size:11px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--mut);margin-bottom:16px;}
.c1-tier-name.c1-acc{color:var(--acc);}
.c1-tier-price{font-family:var(--disp);font-weight:700;font-size:38px;letter-spacing:-.045em;line-height:1;}
.c1-tier-price.c1-vacc{color:var(--acc);}
.c1-tier-per{font-size:11.5px;color:var(--mut2);margin-top:8px;}
.c1-tier-desc{font-size:13px;color:var(--mut);margin:14px 0 16px;line-height:1.5;min-height:42px;}
.c1-tier-feats{list-style:none;padding:0;margin:0 0 18px;flex:1;}
.c1-tier-feats li{display:grid;grid-template-columns:16px 1fr;gap:9px;padding:7px 0;
  font-size:13px;color:var(--ink);border-top:1px solid var(--hair);}
.c1-tier-feats li:first-child{border-top:none;}
.c1-fmk{color:var(--acc);font-family:var(--disp);font-weight:700;font-size:12px;line-height:1.5;}
.c1-tier-cta{font-family:var(--disp);font-weight:700;font-size:13px;text-align:center;padding:12px;
  border-radius:10px;transition:transform .15s,box-shadow .2s,background .2s,border-color .2s,color .2s;}
.c1-tier-cta-acc{background:linear-gradient(180deg,var(--acc-h),var(--acc));color:#0A0F1C;
  box-shadow:0 10px 24px -12px rgba(245,197,24,.6);}
.c1-tier-cta-acc:hover{transform:translateY(-1px);box-shadow:0 14px 30px -12px rgba(245,197,24,.75);}
.c1-tier-cta-out{border:1px solid var(--line);color:var(--ink);background:rgba(255,255,255,.02);}
.c1-tier-cta-out:hover{border-color:rgba(245,197,24,.5);color:var(--acc);}

.c1-agentbar{margin-top:14px;border-radius:16px;border:1px solid var(--line);background:var(--panel);
  box-shadow:var(--panel-sh);padding:24px 26px;display:flex;align-items:center;justify-content:space-between;
  gap:24px;flex-wrap:wrap;}
.c1-agentbar h4{font-family:var(--disp);font-weight:700;font-size:18px;letter-spacing:-.02em;margin:0 0 6px;}
.c1-agentbar p{color:var(--mut);font-size:13.5px;margin:0;max-width:58ch;}
.c1-costline{margin-top:20px;color:var(--mut2);font-size:13px;}
.c1-costline a{color:var(--mut);transition:color .2s;}
.c1-costline a:hover{color:var(--acc);}

/* ===== CLOSING CTA ===== */
.c1-close{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;
  padding:30px 32px;}
.c1-close .c1-cta{margin-top:0;}
.c1-close-k{font-family:var(--disp);font-weight:600;font-size:11px;letter-spacing:.2em;
  text-transform:uppercase;color:var(--acc);margin-bottom:8px;}
.c1-close-h{font-family:var(--disp);font-weight:700;font-size:clamp(22px,3vw,30px);
  letter-spacing:-.03em;line-height:1.05;color:var(--ink);margin:0;}


/* ===== FLOW DIAGRAM ===== */
.c1-flow{margin-top:30px;display:flex;align-items:stretch;gap:0;}
@media(max-width:820px){.c1-flow{flex-direction:column;}}
.c1-fnode{flex:0 0 228px;border:1px solid var(--line);border-radius:16px;background:var(--panel);
  box-shadow:var(--panel-sh);padding:18px;display:flex;flex-direction:column;gap:12px;position:relative;}
@media(max-width:820px){.c1-fnode{flex:1 1 auto;}}
.c1-fnode-mid{border-color:rgba(245,197,24,.3);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 26px 56px -30px rgba(245,197,24,.5);}
.c1-fnode-ico{width:46px;height:46px;border-radius:12px;border:1px solid var(--line);
  display:flex;align-items:center;justify-content:center;color:var(--acc);background:rgba(245,197,24,.06);}
.c1-ico2{color:var(--acc2);border-color:rgba(91,200,250,.28);background:rgba(91,200,250,.06);}
.c1-fnode-tag{font-family:var(--disp);font-weight:600;font-size:10px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--mut2);margin-bottom:8px;}
.c1-fnode-t{font-family:var(--disp);font-weight:700;font-size:18px;letter-spacing:-.02em;margin-bottom:7px;}
.c1-fnode-s{color:var(--mut);font-size:13px;line-height:1.5;}
.c1-fnode-addr{font-family:var(--mono);font-size:11.5px;color:var(--ink);margin-top:auto;
  padding-top:14px;border-top:1px solid var(--hair);}
.c1-fnode-addr.c1-acc{color:var(--acc);}
.c1-flink{flex:1 1 auto;min-width:90px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;padding:0 10px;}
@media(max-width:820px){.c1-flink{min-height:104px;padding:10px 0;}}
.c1-flink-line{position:relative;width:100%;height:2px;border-radius:2px;
  background:linear-gradient(90deg,transparent,var(--line),transparent);}
@media(max-width:820px){.c1-flink-line{width:2px;height:auto;align-self:center;min-height:58px;
  background:linear-gradient(180deg,transparent,var(--line),transparent);}}
.c1-flink-line::after{content:"";position:absolute;right:-1px;top:50%;
  transform:translateY(-50%) rotate(45deg);width:7px;height:7px;
  border-top:2px solid var(--acc);border-right:2px solid var(--acc);opacity:.75;}
@media(max-width:820px){.c1-flink-line::after{right:auto;left:50%;top:auto;bottom:-1px;
  transform:translateX(-50%) rotate(135deg);}}
.c1-flink-dot{position:absolute;top:50%;left:0;width:9px;height:9px;border-radius:50%;
  background:var(--acc);transform:translate(-50%,-50%);
  box-shadow:0 0 0 4px rgba(245,197,24,.13),0 0 14px 2px rgba(245,197,24,.6);
  animation:c1travelH 2.6s cubic-bezier(.6,0,.4,1) infinite;}
.c1-flink-2 .c1-flink-dot{animation-delay:1.3s;}
@keyframes c1travelH{0%{left:0;opacity:0;}9%{opacity:1;}88%{opacity:1;}100%{left:100%;opacity:0;}}
@media(max-width:820px){
  .c1-flink-dot{top:0;left:50%;animation-name:c1travelV;}
  @keyframes c1travelV{0%{top:0;opacity:0;}9%{opacity:1;}88%{opacity:1;}100%{top:100%;opacity:0;}}
}
.c1-flink-top{font-family:var(--disp);font-weight:500;font-size:11px;letter-spacing:.04em;
  color:var(--mut);margin-bottom:14px;text-align:center;white-space:nowrap;}
.c1-flink-1 .c1-flink-top{color:var(--acc2);}
.c1-flink-bot{margin-top:14px;}
.c1-flink-badge{font-family:var(--disp);font-weight:700;font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--acc);border:1px solid rgba(245,197,24,.32);border-radius:999px;
  padding:4px 10px;background:rgba(245,197,24,.07);white-space:nowrap;}
.c1-flow-cap{margin-top:20px;color:var(--mut2);font-size:13.5px;text-align:center;}
.c1-flow-cap b{color:var(--ink);font-weight:600;}
@media(prefers-reduced-motion:reduce){.c1-flink-dot{animation:none;left:100%;opacity:1;}}

/* ===== COMPARISON TABLE (ERC-4337 vs Q402) ===== */
.c1-cmp{margin-top:30px;border:1px solid var(--line);border-radius:16px;overflow:hidden;
  background:var(--panel);box-shadow:var(--panel-sh);}
.c1-cmp-row{display:grid;grid-template-columns:1.1fr 1fr 1.25fr;align-items:stretch;
  border-top:1px solid var(--hair);}
.c1-cmp-row:first-child{border-top:none;}
.c1-cmp-d{padding:15px 22px;font-family:var(--disp);font-weight:600;font-size:14px;color:var(--ink);
  display:flex;align-items:center;}
.c1-cmp-a{padding:15px 22px;color:var(--mut);font-size:14px;display:flex;align-items:center;}
.c1-cmp-b{padding:15px 22px;color:var(--ink);font-size:14px;font-weight:500;display:flex;align-items:center;gap:9px;
  background:linear-gradient(180deg,rgba(245,197,24,.085),rgba(245,197,24,.03));
  border-left:1px solid rgba(245,197,24,.25);}
.c1-cmp-check{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;
  border-radius:50%;background:rgba(245,197,24,.16);color:var(--acc);font-size:10px;font-weight:700;flex-shrink:0;}
.c1-cmp-head{font-family:var(--disp);font-weight:700;font-size:11px;letter-spacing:.16em;text-transform:uppercase;}
.c1-cmp-head .c1-cmp-a{color:var(--mut2);}
.c1-cmp-head .c1-cmp-b{color:var(--acc);}
@media(max-width:620px){
  .c1-cmp-head{display:none;}
  .c1-cmp-row{grid-template-columns:1fr 1fr;}
  .c1-cmp-d{grid-column:1 / -1;padding:14px 18px 2px;font-size:11px;letter-spacing:.12em;
    text-transform:uppercase;color:var(--mut2);}
  .c1-cmp-a,.c1-cmp-b{padding:10px 18px 16px;}
}

/* ===== TRUST RECEIPT CARD (the visual in the §04 split) ===== */
.c1-rcpt-paper{border:1px solid var(--line);border-radius:18px;max-width:none;width:100%;
  background:linear-gradient(180deg,#0B1322,#080E1A);box-shadow:var(--panel-sh);position:relative;}
@media(min-width:821px){.c1-rcpt-paper{margin-top:-26px;}}
.c1-rcpt-top{display:flex;align-items:center;justify-content:space-between;padding:20px 26px;
  border-bottom:1px solid var(--hair);}
.c1-rcpt-brand{display:flex;align-items:center;gap:11px;font-family:var(--disp);letter-spacing:.02em;}
.c1-q{font-family:var(--body);font-weight:700;font-size:18px;letter-spacing:-.025em;line-height:1;
  color:var(--acc);text-transform:none;}
.c1-rcpt-doc{font-weight:600;font-size:13px;color:var(--mut);padding-left:11px;border-left:1px solid var(--hair);}
.c1-rcpt-id{font-family:var(--mono);font-size:12.5px;color:var(--acc2);}
.c1-rcpt-rows{padding:10px 26px;}
.c1-rcpt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 0;
  border-bottom:1px dashed var(--hair);font-size:14.5px;color:var(--mut);}
.c1-rcpt-row:last-child{border-bottom:none;}
.c1-rcpt-v{font-family:var(--mono);font-size:13.5px;color:var(--ink);text-align:right;}
.c1-rcpt-perf{height:0;border-top:1px dashed var(--line);position:relative;}
.c1-rcpt-perf::before,.c1-rcpt-perf::after{content:"";position:absolute;top:-8px;width:16px;height:16px;
  border-radius:50%;background:var(--bg);border:1px solid var(--line);}
.c1-rcpt-perf::before{left:-9px;}
.c1-rcpt-perf::after{right:-9px;}
.c1-rcpt-sig{display:flex;gap:16px;align-items:center;padding:22px 26px;}
.c1-rcpt-seal{width:52px;height:52px;flex:0 0 52px;border-radius:50%;border:1px solid rgba(91,200,250,.4);
  display:flex;align-items:center;justify-content:center;color:var(--acc2);background:rgba(91,200,250,.07);}
.c1-rcpt-sigt{font-family:var(--disp);font-weight:700;font-size:15px;color:var(--ink);margin-bottom:4px;}
.c1-rcpt-sigs{font-size:13px;color:var(--mut);line-height:1.5;}
        `}</style>

        {/* ============================ CHAIN MARQUEE ============================ */}
        <section className="c1-section c1-section-first">
          <ChainMarquee />
        </section>

        {/* ============================ HOW IT WORKS ============================ */}
        <section id="how-it-works" className="c1-section">
          <div className="c1-wrap">
            <Shead
              index="01" kicker="How it works"
              sub="The whole gasless flow, identical on every EVM chain we run."
            >
              Three addresses. One transaction.
            </Shead>

            <FlowDiagram />
          </div>
        </section>

        {/* ============================ USE CASES ============================ */}
        <section id="use-cases" className="c1-section">
          <div className="c1-wrap">
            <Shead
              index="02" kicker="Use cases"
              sub="Any product moving stablecoins on EVM."
            >
              Built for every use case.
            </Shead>

            <div className="c1-uses" data-reveal>
              {USE_CASES.map((u) => (
                <div className={`c1-use ${u.key === 'ai' ? 'c1-use-lead' : ''}`} key={u.key}>
                  <div className="c1-use-head">
                    <span className="c1-use-ico"><UseIcon name={u.key} /></span>
                    <span className="c1-use-cat">
                      {u.label}
                      {u.tag ? <span className="c1-use-new">{u.tag}</span> : null}
                    </span>
                  </div>
                  <h3 className="c1-use-hook">{u.hook}</h3>
                  <div className="c1-use-foot">
                    <div className="c1-use-chips">
                      {u.chips.map((ch) => <span className="c1-chip" key={ch}>{ch}</span>)}
                    </div>
                    {u.key === 'ai' ? (
                      <div className="c1-use-mcp">
                        <div className="c1-use-clients">
                          {AI_CLIENTS.map((cl) => (
                            <ClientLogo key={cl.name} src={cl.src} name={cl.name} inv={'inv' in cl && cl.inv} />
                          ))}
                        </div>
                        <span className="c1-use-more">Plus Gemini, Windsurf, and any other MCP client.</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ CAPABILITIES ============================ */}
        <section className="c1-section">
          <div className="c1-wrap">
            <Shead
              index="03" kicker="Capabilities"
              sub="The SDK and 24-tool MCP server go well past one-shot payments."
            >
              Beyond a single transfer.
            </Shead>

            <div className="c1-bento" data-reveal>
              {CAPABILITIES.map((c) => (
                <div
                  className={`c1-bento-tile ${'feature' in c && c.feature ? 'c1-bento-feature' : ''}`}
                  key={c.t}
                  style={{ gridArea: c.area }}
                >
                  <div className="c1-bento-top">
                    {'logo' in c && c.logo ? <img src={c.logo} alt="" className="c1-cap-logo" /> : null}
                    <span className={`c1-tag ${c.tag === 'Live' ? 'c1-tag-live' : ''}`}>{c.tag}</span>
                  </div>
                  <div>
                    <div className="c1-bento-t">{c.t}</div>
                    <div className="c1-bento-s">{c.s}</div>
                    {'feature' in c && c.feature ? (
                      <div className="c1-bento-chains">
                        {CHAINS.map((ch) => (
                          <img key={ch.name} src={ch.src} alt={ch.name} className="c1-bento-chain" title={ch.name} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ TRUST & SECURITY ============================ */}
        <section className="c1-section">
          <div className="c1-wrap">
            <Shead
              index="04" kicker="Trust & security"
              sub="Users sign off-chain; Q402 sponsors gas and never holds keys or funds."
            >
              Custody never changes hands.
            </Shead>

            <div className="c1-trust" data-reveal>
              <div className="c1-trust-points">
                {SECURITY.map((s) => (
                  <div className="c1-trust-row" key={s.n}>
                    <span className="c1-trust-n">{s.n}</span>
                    <div>
                      <div className="c1-trust-t">{s.t}</div>
                      <p className="c1-trust-b">{s.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <ReceiptCard />
            </div>
          </div>
        </section>

        {/* ============================ WHY GASLESS / VS 4337 ============================ */}
        <section className="c1-section">
          <div className="c1-wrap">
            <Shead
              index="05" kicker="Why Q402"
              sub="Vanilla EOAs via EIP-7702. No account-abstraction tax."
            >
              No bundler. No paymaster.
            </Shead>

            <VersusTable />
          </div>
        </section>

        {/* ============================ PRICING ============================ */}
        <section id="pricing" className="c1-section">
          <div className="c1-wrap">
            <Shead
              index="06" kicker="Pricing"
              sub="Credits plus 30-day access. Top up in-window to upgrade your tier."
            >
              Pick a plan. Ship today.
            </Shead>

            <div className="c1-price" data-reveal>
              {PRICING.map((t) => (
                <div className={`c1-tier ${t.popular ? 'c1-tier-pop' : ''}`} key={t.name}>
                  {t.popular ? <span className="c1-tier-flag">Most popular</span> : null}
                  <div className={`c1-tier-name ${t.accent ? 'c1-acc' : ''}`}>{t.name}</div>
                  <div className={`c1-tier-price ${t.accent ? 'c1-vacc' : ''}`}>{t.price}</div>
                  <div className="c1-tier-per">{t.period}</div>
                  <p className="c1-tier-desc">{t.desc}</p>
                  <ul className="c1-tier-feats">
                    {t.feats.map((f) => (
                      <li key={f}><span className="c1-fmk">✓</span>{f}</li>
                    ))}
                  </ul>
                  <a className={`c1-tier-cta ${t.accent || t.popular ? 'c1-tier-cta-acc' : 'c1-tier-cta-out'}`} href={t.href}>
                    {t.cta}{t.accent ? ' →' : ''}
                  </a>
                </div>
              ))}
            </div>

            <div className="c1-agentbar" data-reveal>
              <div>
                <h4>Running AI agents at scale?</h4>
                <p>
                  High-volume sponsored-TX quota + your own pre-funded Gas Tank for multichain gas,
                  all 10 chains. Built for autonomous agent pipelines.
                </p>
              </div>
              <a className="c1-btn c1-btn-out c1-cta-lg" href="/agents">Agent Plan <span className="c1-arrow">→</span></a>
            </div>

            <p className="c1-costline" data-reveal>
              Same tier prices on every supported chain. &nbsp;·&nbsp;
              <a href="/payment">Custom quote →</a> &nbsp;·&nbsp;
              <a href="/docs">Docs →</a>
            </p>
          </div>
        </section>

        {/* ============================ CLOSING CTA (keeps the #contact anchor) ============================ */}
        <section id="contact" className="c1-section">
          <div className="c1-wrap">
            <div className="c1-close c1-panel" data-reveal>
              <div>
                <div className="c1-close-k">Get started</div>
                <h2 className="c1-close-h">Ship gasless payments today.</h2>
              </div>
              <div className="c1-cta">
                <a className="c1-btn c1-btn-acc c1-cta-lg" href="/event">Start free trial <span className="c1-arrow">→</span></a>
                <a className="c1-btn c1-btn-out c1-cta-lg" href="/docs">Read the docs ↗</a>
              </div>
            </div>
          </div>
        </section>

      </div>
  );
}
