// Chain order: BNB → Ethereum → Avalanche → X Layer → USDC → USDT → Arbitrum → Scroll
const chains = [
  {
    name: "BNB Chain",
    color: "#F0B90B",
    status: "live",
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/bnb.png" alt="BNB Chain" className="w-6 h-6 rounded-full" />
    ),
  },
  {
    name: "Ethereum",
    color: "#627EEA",
    status: "live",
    icon: (
      <svg viewBox="0 0 32 32" className="w-6 h-6" fill="none">
        <rect width="32" height="32" rx="6" fill="#1A1F36"/>
        <path d="M16 4L16 13.5L23.5 17L16 4Z" fill="#627EEA" opacity="0.6"/>
        <path d="M16 4L8.5 17L16 13.5Z" fill="#627EEA"/>
        <path d="M16 21.5L16 28L23.5 18.5L16 21.5Z" fill="#627EEA"/>
        <path d="M16 28L16 21.5L8.5 18.5Z" fill="#627EEA" opacity="0.6"/>
        <path d="M16 20L23.5 17L16 13.5Z" fill="#627EEA" opacity="0.2"/>
        <path d="M8.5 17L16 20L16 13.5Z" fill="#627EEA" opacity="0.6"/>
      </svg>
    ),
  },
  {
    name: "Avalanche",
    color: "#E84142",
    status: "live",
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/avax.png" alt="Avalanche" className="w-6 h-6 rounded-full" />
    ),
  },
  {
    name: "X Layer",
    color: "#CCCCCC",
    status: "live",
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/xlayer.png" alt="X Layer" className="w-6 h-6 rounded-md" />
    ),
  },
  {
    name: "USDC",
    color: "#2775CA",
    status: "stable",
    icon: (
      <svg viewBox="0 0 32 32" className="w-6 h-6" fill="none">
        <circle cx="16" cy="16" r="14" fill="#2775CA"/>
        <path d="M16 7C11 7 7 11 7 16S11 25 16 25 25 21 25 16 21 7 16 7ZM17 21.5V23H15V21.5C13 21 11.5 19.8 11.5 18C11.5 17.5 11.8 17 12.3 17H13.7C14 17 14.2 17.2 14.3 17.5C14.5 18.5 15.1 19 16 19C17.1 19 17.8 18.4 17.8 17.5C17.8 16.7 17.3 16.3 15.7 15.8C13.5 15.1 12 14.2 12 12.3C12 10.7 13.2 9.5 15 9.2V7.5H17V9.2C18.8 9.6 20 10.8 20 12.5C20 13 19.7 13.5 19.2 13.5H17.8C17.5 13.5 17.2 13.3 17.1 13C16.9 12.1 16.4 11.5 15.5 11.5C14.5 11.5 13.8 12.1 13.8 12.9C13.8 13.7 14.3 14.1 16 14.6C18.3 15.3 20 16.1 20 18.1C20 19.8 18.8 21 17 21.5Z" fill="white"/>
      </svg>
    ),
  },
  {
    name: "USDT",
    color: "#26A17B",
    status: "stable",
    icon: (
      <svg viewBox="0 0 32 32" className="w-6 h-6" fill="none">
        <circle cx="16" cy="16" r="14" fill="#26A17B"/>
        <path d="M17.5 17.2C17.4 17.2 16.8 17.3 16 17.3C15.2 17.3 14.6 17.2 14.5 17.2C11.5 17 9.3 16.3 9.3 15.5C9.3 14.7 11.5 14 14.5 13.8V15.9C14.7 15.9 15.2 16 16 16C16.8 16 17.3 15.9 17.5 15.9V13.8C20.5 14 22.7 14.7 22.7 15.5C22.7 16.3 20.5 17 17.5 17.2ZM17.5 13.4V11.5H21.5V9H10.5V11.5H14.5V13.4C11.1 13.6 8.5 14.5 8.5 15.5C8.5 16.5 11.1 17.4 14.5 17.6V23H17.5V17.6C20.9 17.4 23.5 16.5 23.5 15.5C23.5 14.5 20.9 13.6 17.5 13.4Z" fill="white"/>
      </svg>
    ),
  },
  {
    name: "Arbitrum",
    color: "#12AAFF",
    status: "deploying",
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/arbitrum.png" alt="Arbitrum" className="w-6 h-6 rounded-md" />
    ),
  },
  {
    name: "Scroll",
    color: "#EEB431",
    status: "deploying",
    icon: (
      // eslint-disable-next-line @next/next/no-img-element
      <img src="/scroll.png" alt="Scroll" className="w-6 h-6 rounded-md" />
    ),
  },
];

const doubled = [...chains, ...chains];

export default function TrustedBy() {
  return (
    <section className="py-14 overflow-hidden" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(5,7,10,0.5)" }}>
      <p className="text-center text-white/20 text-xs uppercase tracking-[0.25em] font-semibold mb-8 px-6">
        Mainnet Live · Multi-chain EVM
      </p>

      <div className="marquee-track">
        <div className="flex gap-5 animate-marquee" style={{ width: "max-content" }}>
          {doubled.map((chain, i) => (
            <div
              key={i}
              className="flex items-center gap-3 px-5 py-3 rounded-xl flex-shrink-0 group cursor-default transition-all"
              style={{ border: `1px solid rgba(255,255,255,0.07)`, background: "rgba(255,255,255,0.025)" }}
            >
              <div className="flex-shrink-0">{chain.icon}</div>
              <div>
                <span className="text-white/55 text-sm font-medium group-hover:text-white/80 transition-colors whitespace-nowrap block">
                  {chain.name}
                </span>
                {chain.status === "live" && (
                  <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: chain.color }}>
                    Mainnet Live
                  </span>
                )}
                {chain.status === "stable" && (
                  <span className="text-[9px] font-bold uppercase tracking-widest text-white/35">
                    Stablecoin
                  </span>
                )}
                {chain.status === "deploying" && (
                  <span className="text-[9px] font-bold uppercase tracking-widest text-white/30">
                    Deploying
                  </span>
                )}
              </div>
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: chain.status === "deploying" ? "rgba(255,255,255,0.2)" : chain.color,
                  boxShadow: chain.status === "deploying" ? "none" : `0 0 6px ${chain.color}`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
