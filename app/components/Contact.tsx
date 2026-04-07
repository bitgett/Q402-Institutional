"use client";

import { useEffect, useState, useRef } from "react";
import RegisterModal from "./RegisterModal";

const CODE_LINES = [
  { tokens: [{ t: "import", c: "text-purple-400" }, { t: " { Q402 } ", c: "text-white/80" }, { t: "from", c: "text-purple-400" }, { t: ' "@quackai/q402"', c: "text-orange-300" }, { t: ";", c: "text-white/30" }] },
  { tokens: [] },
  { tokens: [{ t: "const", c: "text-purple-400" }, { t: " q402 ", c: "text-blue-300" }, { t: "= ", c: "text-white/40" }, { t: "new", c: "text-yellow" }, { t: " Q402", c: "text-blue-300" }, { t: "({", c: "text-white/40" }] },
  { tokens: [{ t: "  apiKey", c: "text-green-300" }, { t: ": ", c: "text-white/40" }, { t: "process.env", c: "text-orange-300" }, { t: ".Q402_KEY,", c: "text-white/40" }] },
  { tokens: [{ t: "  chain", c: "text-green-300" }, { t: ":  ", c: "text-white/40" }, { t: '"bnb"', c: "text-orange-300" }, { t: ",", c: "text-white/40" }] },
  { tokens: [{ t: "});", c: "text-white/40" }] },
  { tokens: [] },
  { tokens: [{ t: "const", c: "text-purple-400" }, { t: " result ", c: "text-blue-300" }, { t: "= ", c: "text-white/40" }, { t: "await", c: "text-yellow" }, { t: " q402", c: "text-blue-300" }, { t: ".", c: "text-white/40" }, { t: "send", c: "text-blue-300" }, { t: "({", c: "text-white/40" }] },
  { tokens: [{ t: "  payload", c: "text-green-300" }, { t: ",", c: "text-white/40" }] },
  { tokens: [{ t: "  signature", c: "text-green-300" }, { t: ",", c: "text-white/40" }] },
  { tokens: [{ t: "});", c: "text-white/40" }] },
  { tokens: [] },
  { tokens: [{ t: "// ✓ ", c: "text-white/25" }, { t: "result.success", c: "text-green-400" }, { t: "  true", c: "text-white/40" }] },
  { tokens: [{ t: "// ✓ ", c: "text-white/25" }, { t: "result.txHash", c: "text-green-400" }, { t: "   0xd4e8...a3f1", c: "text-white/40" }] },
  { tokens: [{ t: "// ✓ ", c: "text-white/25" }, { t: "result.gasUsed", c: "text-yellow" }, { t: "  $0.000000", c: "text-yellow font-bold" }] },
];

const TERMINAL_LINES = [
  { text: "$ node gasless.js",                  color: "text-white/70",  delay: 0    },
  { text: "",                                     color: "",               delay: 500  },
  { text: "  Connecting to BNB Chain...",        color: "text-white/30",  delay: 800  },
  { text: "✓ Connected",                         color: "text-green-400", delay: 1400 },
  { text: "",                                     color: "",               delay: 1600 },
  { text: "  Building EIP-712 payload...",       color: "text-white/30",  delay: 1800 },
  { text: "✓ Payload created",                   color: "text-green-400", delay: 2300 },
  { text: "",                                     color: "",               delay: 2500 },
  { text: "  Waiting for user signature...",     color: "text-white/30",  delay: 2700 },
  { text: "✓ Signed  gas: $0.000000",           color: "text-green-400", delay: 3400 },
  { text: "",                                     color: "",               delay: 3600 },
  { text: "  Submitting transaction...",         color: "text-white/30",  delay: 3800 },
  { text: "✓ Submitted",                         color: "text-green-400", delay: 4300 },
  { text: "✓ Confirmed  block #38,482,910",      color: "text-green-400", delay: 4900 },
  { text: "",                                     color: "",               delay: 5200 },
  { text: "  txHash    0xd4e8...a3f1",           color: "text-white/25",  delay: 5400 },
  { text: "  gasUsed   $0.000000  ← user paid",  color: "text-yellow",    delay: 5600 },
  { text: "  USDC      50.00 transferred ✓",     color: "text-white/55",  delay: 5800 },
];

function BigTerminal() {
  const [termLines, setTermLines] = useState(0);
  const [showCursor, setShowCursor] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          TERMINAL_LINES.forEach((_, i) => {
            const t = setTimeout(() => setTermLines(i + 1), TERMINAL_LINES[i].delay);
            timers.current.push(t);
          });
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(el);
    return () => { observer.disconnect(); timers.current.forEach(clearTimeout); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setShowCursor(v => !v), 530);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={ref} className="w-full rounded-2xl overflow-hidden shadow-2xl shadow-black/70" style={{ border: "1px solid rgba(245,197,24,0.12)", background: "#070D18" }}>

      {/* Title bar */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-b" style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.07)" }}>
        <span className="w-3 h-3 rounded-full bg-red-500/60" />
        <span className="w-3 h-3 rounded-full" style={{ background: "rgba(245,197,24,0.5)" }} />
        <span className="w-3 h-3 rounded-full bg-green-400/50" />
        {/* Tabs */}
        <div className="ml-6 flex items-center gap-1">
          <div className="px-4 py-1 rounded-md text-xs font-mono text-white/70 border" style={{ background: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.10)" }}>
            gasless.js
          </div>
          <div className="px-4 py-1 rounded-md text-xs font-mono text-white/25">
            .env
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400" style={{ boxShadow: "0 0 5px #4ade80" }} />
          <span className="text-[10px] text-white/25 font-mono">bnb mainnet · connected</span>
        </div>
      </div>

      {/* Split pane */}
      <div className="grid md:grid-cols-2 divide-x divide-white/[0.06]">

        {/* LEFT: code editor */}
        <div className="p-5 font-mono text-xs leading-[1.9] border-r" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="text-white/15 text-[10px] uppercase tracking-widest mb-3 font-sans">gasless.js</div>
          {CODE_LINES.map((line, i) => (
            <div key={i} className="flex">
              <span className="text-white/15 w-6 flex-shrink-0 select-none text-right mr-4">{i + 1}</span>
              <span>
                {line.tokens.map((tok, j) => (
                  <span key={j} className={tok.c}>{tok.t}</span>
                ))}
              </span>
            </div>
          ))}
        </div>

        {/* RIGHT: terminal */}
        <div className="p-5 font-mono text-xs leading-[1.9]" style={{ background: "rgba(0,0,0,0.3)" }}>
          <div className="text-white/15 text-[10px] uppercase tracking-widest mb-3 font-sans">terminal</div>
          {TERMINAL_LINES.slice(0, termLines).map((line, i) => (
            <div key={i} className={line.color}>{line.text}</div>
          ))}
          {termLines < TERMINAL_LINES.length && (
            <span className={`inline-block w-2 h-[13px] align-middle ${showCursor ? "bg-white/60" : "bg-transparent"}`} />
          )}
          {termLines >= TERMINAL_LINES.length && (
            <div className="mt-1">
              <span className="text-white/35">$ </span>
              <span className={`inline-block w-2 h-[13px] align-middle ${showCursor ? "bg-white/50" : "bg-transparent"}`} />
            </div>
          )}
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center justify-between px-5 py-2 border-t text-[10px] font-mono" style={{ background: "rgba(245,197,24,0.04)", borderColor: "rgba(245,197,24,0.08)" }}>
        <div className="flex items-center gap-4 text-white/25">
          <span>EIP-712 + EIP-7702</span>
          <span>·</span>
          <span>USDC · BNB Chain</span>
        </div>
        <div className="flex items-center gap-1.5 text-yellow/60">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow/60" />
          <span>gasUsed: $0.000000</span>
        </div>
      </div>
    </div>
  );
}

export default function Contact() {
  const [showModal, setShowModal] = useState(false);

  return (
    <section id="contact" className="py-24 px-6 overflow-hidden" style={{ background: "linear-gradient(180deg, transparent 0%, rgba(245,197,24,0.025) 50%, transparent 100%)" }}>
      <div className="max-w-6xl mx-auto">

        {/* Top: headline + stats */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 bg-yellow/10 border border-yellow/20 text-yellow text-xs font-semibold px-4 py-2 rounded-full mb-7 uppercase tracking-widest">
            Early Access
          </div>
          <h2 className="text-4xl md:text-5xl font-extrabold leading-[1.1] mb-4 tracking-tight">
            Scale your product to{" "}
            <span className="text-shimmer">100M Web3 users.</span>
          </h2>
          <p className="text-white/40 text-lg font-light mb-8 max-w-xl mx-auto">
            Without asking them to buy gas.
          </p>

          {/* Stats */}
          <div className="inline-flex items-center gap-8 bg-white/[0.03] border border-white/8 rounded-2xl px-8 py-4 mb-10">
            {[
              { value: "40+",   label: "Projects live" },
              { value: "41M+",  label: "Txs processed" },
              { value: "1 day", label: "Avg. onboarding" },
            ].map((stat, i) => (
              <div key={stat.label} className="flex items-center gap-8">
                {i > 0 && <div className="w-px h-8 bg-white/10" />}
                <div className="text-center">
                  <div className="text-2xl font-extrabold text-yellow font-mono">{stat.value}</div>
                  <div className="text-white/30 text-xs mt-0.5">{stat.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => setShowModal(true)}
              className="inline-flex items-center gap-3 bg-yellow text-navy font-bold text-sm px-8 py-4 rounded-full hover:bg-yellow-hover transition-all hover:scale-105 shadow-lg shadow-yellow/20"
            >
              Talk to Us →
            </button>
            <a href="/docs" className="inline-flex items-center gap-2 text-sm text-white/40 hover:text-white transition-colors">
              <span className="w-8 h-8 rounded-full border border-white/12 flex items-center justify-center text-xs">↗</span>
              Read the docs
            </a>
          </div>
          <p className="text-white/20 text-xs mt-4">We typically respond within 24 hours.</p>
        </div>

        {/* Full-width terminal */}
        <BigTerminal />
      </div>

      {showModal && <RegisterModal onClose={() => setShowModal(false)} />}
    </section>
  );
}
