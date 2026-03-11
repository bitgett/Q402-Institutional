const tiers = [
  {
    name: "Starter",
    price: "$29",
    period: "/mo",
    description: "For early-stage apps and MVPs.",
    features: [
      "1,000 sponsored transactions/mo",
      "BNB Chain · Avalanche · X Layer",
      "Full API access",
      "Community support",
    ],
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
  {
    name: "Growth",
    price: "$89",
    period: "/mo",
    description: "For growing products with real users.",
    features: [
      "10,000 sponsored transactions/mo",
      "All supported EVM chains",
      "API access + webhooks",
      "Email support",
    ],
    cta: "Get started",
    href: "/payment",
    highlight: true,
  },
  {
    name: "Enterprise",
    price: "$449",
    period: "/mo",
    description: "For high-volume, mission-critical apps.",
    features: [
      "Unlimited transactions",
      "All supported EVM chains",
      "Priority queue + custom policies",
      "Slack / dedicated support",
    ],
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Simple, transparent pricing</h2>
          <p className="text-white/50 max-w-xl mx-auto">
            Sponsor gas for your users on any EVM chain. Plans scale with your product — from early MVPs to enterprise.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5 max-w-4xl mx-auto">
          {tiers.map((tier, i) => (
            <div
              key={i}
              className={`rounded-2xl p-6 flex flex-col border transition-all ${
                tier.highlight
                  ? "bg-yellow/10 border-yellow/40 shadow-lg shadow-yellow/10"
                  : "bg-card border-white/10"
              }`}
            >
              {tier.highlight && (
                <div className="text-yellow text-xs font-bold uppercase tracking-widest mb-3">
                  Most popular
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

        {/* Cost context */}
        <div className="mt-10 text-center">
          <p className="text-white/25 text-sm">
            Prices shown for BNB Chain (base rate). Other chains may vary. <a href="/payment" className="text-yellow/60 hover:text-yellow underline transition-colors">Build a custom quote →</a>
          </p>
        </div>
      </div>
    </section>
  );
}
