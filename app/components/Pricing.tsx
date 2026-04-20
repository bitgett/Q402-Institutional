"use client";

// Pricing must mirror the authoritative tiers in app/lib/blockchain.ts.
// Landing shows 4 headline tiers; the full 7-tier range (including Basic,
// Growth, Business) is available on /payment. If TIER_CREDITS /
// CHAIN_THRESHOLDS change in blockchain.ts, update this table too.
const tiers = [
  {
    name: "Starter",
    price: "$29",
    credits: "500 sponsored transactions",
    features: ["Sandbox + live keys", "All 5 EVM chains", "Community support"],
    badge: null,
    highlight: false,
    href: "/payment",
    cta: "Get started",
  },
  {
    name: "Pro",
    price: "$149",
    credits: "10,000 sponsored transactions",
    features: ["All 5 EVM chains", "Full API + webhooks", "Email support"],
    badge: "Most popular",
    highlight: true,
    href: "/payment",
    cta: "Get started",
  },
  {
    name: "Scale",
    price: "$449",
    credits: "50,000 sponsored transactions",
    features: ["All 5 EVM chains", "Full API + webhooks", "Priority support"],
    badge: null,
    highlight: false,
    href: "/payment",
    cta: "Get started",
  },
  {
    name: "Enterprise",
    price: "$1,999",
    credits: "500,000 sponsored transactions",
    features: ["All 5 EVM chains", "SLA + dedicated support", "Custom tiers available"],
    badge: null,
    highlight: false,
    href: "/payment",
    cta: "Get started",
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">Transaction pricing</h2>
          <p className="text-white/40 text-sm">Per-transaction cost, paid in stablecoins. Settle in seconds across five EVM chains.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {tiers.map((tier, i) => (
            <div
              key={i}
              className={`rounded-2xl p-6 flex flex-col border transition-all ${
                tier.highlight
                  ? "bg-yellow/10 border-yellow/40 shadow-lg shadow-yellow/10"
                  : "bg-card border-white/10"
              }`}
            >
              {tier.badge && (
                <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-3">
                  {tier.badge}
                </div>
              )}
              <div className="mb-4">
                <div className="text-lg font-semibold mb-1">{tier.name}</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-white/40 text-xs">from</span>
                  <span className="text-3xl font-extrabold">{tier.price}</span>
                  <span className="text-white/40 text-sm">/30-day access</span>
                </div>
                <p className="text-white/50 text-sm mt-2">{tier.credits}</p>
              </div>

              <ul className="flex-1 space-y-2 mb-6">
                {tier.features.map((f, j) => (
                  <li key={j} className="flex items-start gap-2 text-sm text-white/70">
                    <span className="text-yellow mt-0.5 flex-shrink-0">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              <a
                href={tier.href}
                className={`text-center text-sm font-semibold py-3 rounded-full transition-all ${
                  tier.highlight
                    ? "bg-yellow text-navy hover:bg-yellow-hover"
                    : "border border-white/20 text-white hover:bg-white/5"
                }`}
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-white/30">
          30-day access window · credits accumulate across renewals · tier upgrades automatically on cumulative spend
        </p>

        {/* Agent CTA */}
        <div className="mt-6 rounded-2xl border border-white/8 px-8 py-6 flex flex-col md:flex-row items-center justify-between gap-4" style={{ background: "linear-gradient(135deg, rgba(74,229,74,0.04) 0%, rgba(255,255,255,0.01) 100%)" }}>
          <div>
            <p className="text-sm font-semibold text-white/80">Running AI agents at scale?</p>
            <p className="text-xs text-white/35 mt-0.5">Unlimited TX, Gas Tank pre-pay, all 5 chains. Built for autonomous agent pipelines.</p>
          </div>
          <a href="/agents" className="flex-shrink-0 border border-green-400/40 text-green-400 hover:bg-green-400/10 text-sm font-semibold px-5 py-2.5 rounded-full transition-all whitespace-nowrap">
            Agent Plan →
          </a>
        </div>

        {/* Cost context */}
        <div className="mt-6 text-center">
          <p className="text-white/25 text-sm">
            Prices shown are BNB Chain base rates. Ethereum and Avalanche are slightly higher. &nbsp;·&nbsp;
            <a href="/payment" className="text-white/40 hover:text-white transition-colors">All tiers + per-chain quote →</a>
            &nbsp;·&nbsp;
            <a href="/docs" className="text-white/40 hover:text-white transition-colors">Docs →</a>
          </p>
        </div>
      </div>
    </section>
  );
}
