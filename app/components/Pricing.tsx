"use client";

// Pricing must mirror the authoritative tiers in app/lib/blockchain.ts.
// Landing shows 4 headline tiers; the full 7-tier range (including Basic,
// Growth, Business) is available on /payment. If TIER_CREDITS / DAILY_CAP
// change in blockchain.ts or app/api/relay/route.ts, update this table too.
const tiers = [
  {
    name:     "Starter",
    price:    "$29",
    credits:  "500",
    dailyCap: "50",
    chains:   "5",
    badge:    null,
    highlight: false,
  },
  {
    name:     "Pro",
    price:    "$149",
    credits:  "10,000",
    dailyCap: "1,000",
    chains:   "5",
    badge:    "Most popular",
    highlight: true,
  },
  {
    name:     "Scale",
    price:    "$449",
    credits:  "50,000",
    dailyCap: "10,000",
    chains:   "5",
    badge:    null,
    highlight: false,
  },
  {
    name:     "Enterprise",
    price:    "$1,999",
    credits:  "500,000",
    dailyCap: "∞",
    chains:   "5",
    badge:    null,
    highlight: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">Transaction pricing</h2>
          <p className="text-white/40 text-sm">
            Per-transaction cost, paid in stablecoins. Settle in seconds across five EVM chains.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {tiers.map((tier, i) => (
            <div
              key={i}
              className={`relative rounded-xl flex flex-col border transition-all ${
                tier.highlight
                  ? "bg-yellow/[0.06] border-yellow/40 shadow-lg shadow-yellow/10"
                  : "bg-white/[0.02] border-white/8 hover:border-white/15"
              }`}
            >
              {tier.badge && (
                <div className="absolute -top-2.5 left-5 bg-yellow text-navy text-[10px] font-bold uppercase tracking-[0.15em] px-2 py-0.5 rounded-sm">
                  {tier.badge}
                </div>
              )}

              {/* Header: name + price */}
              <div className="px-6 pt-7 pb-5 border-b border-white/6">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-semibold">
                    {tier.name}
                  </span>
                  <span className="text-[10px] font-mono text-white/25">
                    TIER_{String(i).padStart(2, "0")}
                  </span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold font-mono tracking-tight">{tier.price}</span>
                  <span className="text-white/25 text-xs font-mono">USD</span>
                </div>
              </div>

              {/* Spec grid: credits / daily cap / chains */}
              <dl className="grid grid-cols-3 divide-x divide-white/6 text-center">
                <div className="px-2 py-4">
                  <dd className="text-sm font-bold font-mono text-white">{tier.credits}</dd>
                  <dt className="text-[10px] uppercase tracking-wider text-white/35 mt-1">credits</dt>
                </div>
                <div className="px-2 py-4">
                  <dd className="text-sm font-bold font-mono text-white">{tier.dailyCap}</dd>
                  <dt className="text-[10px] uppercase tracking-wider text-white/35 mt-1">daily cap</dt>
                </div>
                <div className="px-2 py-4">
                  <dd className="text-sm font-bold font-mono text-white">{tier.chains}</dd>
                  <dt className="text-[10px] uppercase tracking-wider text-white/35 mt-1">chains</dt>
                </div>
              </dl>

              {/* CTA */}
              <div className="px-4 pb-4 pt-2 border-t border-white/6 mt-auto">
                <a
                  href="/payment"
                  className={`block text-center text-xs font-semibold py-2.5 rounded-md transition-all font-mono uppercase tracking-[0.15em] ${
                    tier.highlight
                      ? "bg-yellow text-navy hover:bg-yellow-hover"
                      : "bg-white/[0.04] text-white/80 hover:bg-white/[0.08] border border-white/10"
                  }`}
                >
                  $ q402 init →
                </a>
              </div>
            </div>
          ))}
        </div>

        {/* Data-row footer */}
        <div className="mt-8 rounded-lg border border-white/6 bg-white/[0.01] font-mono text-[11px] text-white/40 divide-y divide-white/6">
          <div className="flex items-center px-5 py-2.5 gap-3 flex-wrap">
            <span className="text-white/25">{"//"}</span>
            <span><span className="text-yellow/70">window</span> = 30d</span>
            <span className="text-white/15">·</span>
            <span><span className="text-yellow/70">credits</span> = cumulative</span>
            <span className="text-white/15">·</span>
            <span><span className="text-yellow/70">tier</span> = auto-upgrade on cumulative spend</span>
            <span className="text-white/15">·</span>
            <span><span className="text-yellow/70">chains</span> = [bnb, eth, avax, xlayer, stable]</span>
          </div>
          <div className="flex items-center px-5 py-2.5 gap-3 flex-wrap">
            <span className="text-white/25">{"//"}</span>
            <span><span className="text-yellow/70">multipliers</span> = {"{ bnb: 1.0, xlayer: 1.0, stable: 1.0, avax: 1.1, eth: 1.5 }"}</span>
          </div>
        </div>

        {/* Agent CTA — kept distinct, still part of Pricing */}
        <div className="mt-6 rounded-xl border border-white/8 px-7 py-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4" style={{ background: "linear-gradient(135deg, rgba(74,229,74,0.04) 0%, rgba(255,255,255,0.01) 100%)" }}>
          <div>
            <p className="text-sm font-semibold text-white/80 font-mono">Agent plan · unlimited TX</p>
            <p className="text-xs text-white/35 mt-0.5">Gas-Tank pre-pay model for autonomous agent pipelines. All 5 chains.</p>
          </div>
          <a href="/agents" className="flex-shrink-0 border border-green-400/40 text-green-400 hover:bg-green-400/10 text-xs font-mono uppercase tracking-[0.15em] px-5 py-2.5 rounded-md transition-all whitespace-nowrap">
            agents/ →
          </a>
        </div>

        {/* Context links */}
        <div className="mt-6 text-center font-mono text-[11px] text-white/30">
          <a href="/payment" className="hover:text-white transition-colors">./payment</a>
          <span className="mx-2 text-white/15">·</span>
          <a href="/docs" className="hover:text-white transition-colors">./docs</a>
          <span className="mx-2 text-white/15">·</span>
          <span>base = BNB · avax ×1.1 · eth ×1.5</span>
        </div>
      </div>
    </section>
  );
}
