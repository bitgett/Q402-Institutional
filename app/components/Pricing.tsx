"use client";

import { useState } from "react";
import RegisterModal from "./RegisterModal";

const tiers = [
  {
    name: "Starter",
    price: "$30",
    period: "/mo",
    description: "For indie developers and early-stage projects.",
    features: [
      "500 sponsored transactions/mo",
      "BNB Chain supported",
      "Full API access",
      "Community support",
    ],
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
  {
    name: "Growth",
    price: "$150",
    period: "/mo",
    description: "For growing products with real users.",
    features: [
      "10,000 sponsored transactions/mo",
      "All supported EVM chains",
      "Full API access",
      "Email support",
    ],
    cta: "Get started",
    href: "/payment",
    highlight: true,
  },
  {
    name: "Scale",
    price: "$800",
    period: "/mo",
    description: "For high-throughput DeFi applications.",
    features: [
      "100,000 sponsored transactions/mo",
      "All supported EVM chains",
      "API access + webhooks",
      "Priority support",
    ],
    cta: "Get started",
    href: "/payment",
    highlight: false,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For mission-critical apps at any scale.",
    features: [
      "500K+ sponsored transactions/mo",
      "All supported EVM chains",
      "SLA guarantee (99.9% uptime)",
      "Dedicated account manager",
    ],
    cta: "Contact Sales",
    href: null,
    highlight: false,
  },
];

export default function Pricing() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
    <section id="pricing" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">Pick a plan. Ship today.</h2>
          <p className="text-white/40 text-sm">No gas. No friction. Plug in the SDK and you&apos;re live.</p>
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

              {tier.href === null ? (
                <button
                  onClick={() => setShowModal(true)}
                  className={`w-full text-center text-sm font-semibold py-3 rounded-full transition-all border border-white/20 text-white hover:bg-white/5`}
                >
                  {tier.cta}
                </button>
              ) : (
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
              )}
            </div>
          ))}
        </div>

        {/* Cost context */}
        <div className="mt-10 text-center">
          <p className="text-white/25 text-sm">
            BNB Chain pricing. Other chains may vary. &nbsp;·&nbsp;
            <a href="/payment" className="text-white/40 hover:text-white transition-colors">Custom quote →</a>
            &nbsp;·&nbsp;
            <a href="/docs" className="text-white/40 hover:text-white transition-colors">Docs →</a>
          </p>
        </div>
      </div>
    </section>
    {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </>
  );
}
