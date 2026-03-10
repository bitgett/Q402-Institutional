const cases = [
  {
    icon: "⬡",
    title: "DeFi Onboarding",
    description:
      "Let new users interact with your DeFi protocol immediately — no AVAX top-up, no confusing wallet pop-ups.",
  },
  {
    icon: "◈",
    title: "NFT Minting",
    description:
      "Remove the gas barrier for NFT drops. Your users mint without ever touching AVAX.",
  },
  {
    icon: "◻",
    title: "SaaS Subscriptions",
    description:
      "Charge USDC subscription fees on-chain. Users authorize once, you collect — gaslessly.",
  },
  {
    icon: "◆",
    title: "Web3 Gaming",
    description:
      "In-game purchases and micro-transactions with zero friction. Players focus on the game, not gas.",
  },
  {
    icon: "◎",
    title: "B2B Payments",
    description:
      "Send USDC payments between businesses on Avalanche with minimal cost and full on-chain auditability.",
  },
  {
    icon: "▲",
    title: "Cross-App Wallets",
    description:
      "Build embedded wallets and smart accounts where gas is invisible by design.",
  },
];

export default function UseCases() {
  return (
    <section id="use-cases" className="py-24 px-6 bg-card/30">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">Built for every use case</h2>
          <p className="text-white/50 max-w-xl mx-auto">
            Any product that needs seamless, gasless USDC transfers on Avalanche.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {cases.map((c, i) => (
            <div
              key={i}
              className="bg-card border border-white/10 rounded-2xl p-6 hover:border-yellow/20 transition-colors group"
            >
              <div className="text-yellow text-2xl mb-4">{c.icon}</div>
              <h3 className="font-semibold text-base mb-2 group-hover:text-yellow transition-colors">
                {c.title}
              </h3>
              <p className="text-white/50 text-sm leading-relaxed">{c.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
