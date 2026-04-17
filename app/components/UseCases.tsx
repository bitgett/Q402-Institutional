const cases = [
  {
    icon: "⬡",
    title: "DeFi Onboarding",
    description:
      "Let new users interact with your DeFi protocol immediately — no gas top-up, no confusing wallet pop-ups.",
  },
  {
    icon: "◈",
    title: "NFT Minting",
    description:
      "Remove the gas barrier for NFT drops. Your users mint without ever touching a gas token.",
  },
  {
    icon: "◎",
    title: "AI Agent Infrastructure",
    description:
      "Run hundreds of agents on-chain. Pre-fund a shared Gas Tank once — every agent in your fleet executes gasless payments autonomously, no native token management needed.",
    highlight: true,
  },
  {
    icon: "◆",
    title: "Web3 Gaming",
    description:
      "In-game purchases and micro-transactions with zero friction. Players focus on the game, not gas.",
  },
  {
    icon: "▣",
    title: "B2B Payments",
    description:
      "Send USDC payments between businesses on-chain with minimal cost and full auditability.",
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
            Any product that needs seamless, gasless USDC/USDT transfers on EVM.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {cases.map((c, i) => (
            <div
              key={i}
              className={`border rounded-2xl p-6 transition-colors group ${
                c.highlight
                  ? "bg-green-400/[0.04] border-green-400/20 hover:border-green-400/40"
                  : "bg-card border-white/10 hover:border-yellow/20"
              }`}
            >
              <div className={`text-2xl mb-4 ${c.highlight ? "text-green-400" : "text-yellow"}`}>{c.icon}</div>
              <h3 className={`font-semibold text-base mb-2 transition-colors ${
                c.highlight ? "text-green-300 group-hover:text-green-200" : "group-hover:text-yellow"
              }`}>
                {c.title}
                {c.highlight && (
                  <span className="ml-2 text-[10px] font-bold uppercase tracking-widest text-green-400/70 border border-green-400/20 rounded-full px-2 py-0.5 align-middle">
                    New
                  </span>
                )}
              </h3>
              <p className="text-white/50 text-sm leading-relaxed">{c.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
