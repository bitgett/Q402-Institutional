export default function Footer() {
  return (
    <footer className="border-t border-white/10 py-10 px-6">
      <div className="max-w-6xl mx-auto">
        {/* Top row */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-8">
          <div>
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-yellow font-bold text-lg">Q402</span>
              <span className="text-white/30 text-sm">by Quack AI</span>
            </div>
            <p className="text-white/30 text-xs max-w-xs leading-relaxed">
              Gasless Payment Protocol · EIP-712 + EIP-7702 · Multi-chain EVM
            </p>
          </div>

          {/* Chain badges */}
          <div className="flex flex-wrap gap-2">
            {[
              { name: "Avalanche", color: "#E84142" },
              { name: "BNB Chain", color: "#F0B90B" },
              { name: "X Layer",   color: "#CCCCCC" },
              { name: "Ethereum",  color: "#627EEA" },
              { name: "Stable",    color: "#4AE54A" },
            ].map((c) => (
              <span
                key={c.name}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-white/8 bg-white/3 text-white/40"
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.color }} />
                {c.name}
              </span>
            ))}
          </div>
        </div>

        {/* Stats bar */}
        <div className="flex flex-wrap items-center gap-6 py-5 border-y border-white/8 mb-6">
          <div className="flex items-center gap-2">
            <span className="text-yellow font-bold font-mono text-sm">41,132,423</span>
            <span className="text-white/30 text-xs">total transactions processed</span>
          </div>
          <div className="w-px h-4 bg-white/10 hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-sm">5+</span>
            <span className="text-white/30 text-xs">EVM chains supported</span>
          </div>
          <div className="w-px h-4 bg-white/10 hidden sm:block" />
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 5px #4ade80" }} />
            <span className="text-white/30 text-xs">Protocol live on mainnet</span>
          </div>
        </div>

        {/* Bottom row */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-white/20 text-xs">
            © 2026 Quack AI. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a href="/terms" className="text-white/25 text-xs hover:text-white/60 transition-colors">Terms</a>
            <a href="/privacy" className="text-white/25 text-xs hover:text-white/60 transition-colors">Privacy</a>
            <a href="mailto:davidlee@quackai.ai" className="text-white/30 text-xs hover:text-white transition-colors">
              davidlee@quackai.ai
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
