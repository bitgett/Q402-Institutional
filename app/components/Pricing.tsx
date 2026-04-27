"use client";

const tiers = [
  {
    name: "Starter",
    price: "$29",
    period: "/30-day access",
    description: "For indie developers and early-stage projects.",
    features: [
      "500 sponsored transactions",
      "All 6 EVM chains",
      "Full API access",
      "Community support",
    ],
    badge: null,
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
  {
    name: "Pro",
    price: "$149",
    period: "/30-day access",
    description: "For growing products with real users.",
    features: [
      "10,000 sponsored transactions",
      "All 6 EVM chains",
      "Full API access",
      "Email support",
    ],
    badge: "Most popular",
    cta: "Get started",
    href: "/payment",
    highlight: true,
  },
  {
    name: "Scale",
    price: "$449",
    period: "/30-day access",
    description: "For high-throughput DeFi applications.",
    features: [
      "50,000 sponsored transactions",
      "All 6 EVM chains",
      "API access + webhooks",
      "Priority support",
    ],
    badge: null,
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
  {
    name: "Enterprise",
    price: "$1,999",
    period: "/30-day access",
    description: "For mission-critical apps at any scale.",
    features: [
      "500,000 sponsored transactions",
      "All 6 EVM chains",
      "SLA guarantee (99.9% uptime)",
      "Dedicated account manager",
    ],
    badge: null,
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">Pick a plan. Ship today.</h2>
          <p className="text-white/40 text-sm max-w-2xl mx-auto">Each purchase = credits + 30-day access. Top up within the window and your tier upgrades automatically. No gas, no friction — plug in the SDK and you&apos;re live.</p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
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
                  <span className="text-3xl font-extrabold">{tier.price}</span>
                  {tier.period && <span className="text-white/40 text-sm">{tier.period}</span>}
                </div>
                <p className="text-white/50 text-sm mt-2">{tier.description}</p>
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
                href={tier.href!}
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

        {/* Agent CTA */}
        <div className="mt-8 rounded-2xl border border-white/8 px-8 py-6 flex flex-col md:flex-row items-center justify-between gap-4" style={{ background: "linear-gradient(135deg, rgba(74,229,74,0.04) 0%, rgba(255,255,255,0.01) 100%)" }}>
          <div>
            <p className="text-sm font-semibold text-white/80">Running AI agents at scale?</p>
            <p className="text-xs text-white/35 mt-0.5">Unlimited TX, Gas Tank pre-pay, all 6 chains. Built for autonomous agent pipelines.</p>
          </div>
          <a href="/agents" className="flex-shrink-0 border border-green-400/40 text-green-400 hover:bg-green-400/10 text-sm font-semibold px-5 py-2.5 rounded-full transition-all whitespace-nowrap">
            Agent Plan →
          </a>
        </div>

        {/* Cost context */}
        <div className="mt-6 text-center">
          <p className="text-white/25 text-sm">
            BNB Chain pricing. Other chains may vary. &nbsp;·&nbsp;
            <a href="/payment" className="text-white/40 hover:text-white transition-colors">Custom quote →</a>
            &nbsp;·&nbsp;
            <a href="/docs" className="text-white/40 hover:text-white transition-colors">Docs →</a>
          </p>
        </div>
      </div>
    </section>
  );
}
