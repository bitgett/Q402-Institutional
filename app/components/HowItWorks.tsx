"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

const steps = [
  {
    label: "A", color: "#E84142",
    title: "User signs off-chain",
    description: "Address A signs a typed EIP-712 authorization. No gas, no blockchain interaction. Works from any EVM wallet on any supported chain.",
    tag: "Zero gas needed",
  },
  {
    label: "B", color: "#F5C518",
    title: "API submits transaction",
    description: "Your backend (Address B) receives the signature and submits one on-chain transaction, sponsoring the micro-gas fee.",
    tag: "1 transaction total",
  },
  {
    label: "C", color: "#4ade80",
    title: "Recipient receives",
    description: "Address C receives the USDC instantly. Verifiable on Snowtrace, BscScan, Etherscan — whichever chain you use.",
    tag: "On-chain verified",
  },
];

const TERMINAL_LINES = [
  { text: "$ q402 simulate --chain bnb --amount 50", color: "text-white/70", delay: 0 },
  { text: "> Connecting to BNB Chain...", color: "text-white/30", delay: 400 },
  { text: "> Building EIP-712 payload...", color: "text-white/30", delay: 900 },
  { text: "> User signed  (gas: $0.00000)", color: "text-green-400", delay: 1500 },
  { text: "> Submitting via facilitator...", color: "text-white/30", delay: 2100 },
  { text: "> tx: 0xf3c8a2...d91e  CONFIRMED", color: "text-green-400", delay: 2800 },
  { text: "> USDC transferred: $50.00", color: "text-yellow", delay: 3400 },
  { text: "> Gas paid by user: $0.000000 ✓", color: "text-yellow", delay: 4000 },
];

function TypingTerminal() {
  const [visible, setVisible] = useState<number[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  function start() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setVisible([]);
    TERMINAL_LINES.forEach((line, i) => {
      const t = setTimeout(() => setVisible(v => [...v, i]), line.delay + 300);
      timers.current.push(t);
    });
    const restart = setTimeout(start, TERMINAL_LINES[TERMINAL_LINES.length - 1].delay + 3800);
    timers.current.push(restart);
  }

  useEffect(() => {
    start();
    return () => timers.current.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-[#060C14] border rounded-2xl overflow-hidden" style={{ borderColor: "rgba(245,197,24,0.1)" }}>
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.06)" }}>
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
        <span className="w-2.5 h-2.5 rounded-full bg-yellow/50" />
        <span className="w-2.5 h-2.5 rounded-full bg-green-400/50" />
        <span className="ml-3 text-white/20 text-xs font-mono">q402-cli · live simulation</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[10px] text-white/20 font-mono">running</span>
        </div>
      </div>
      <div className="p-5 font-mono text-xs leading-7 min-h-[240px]">
        {TERMINAL_LINES.map((line, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -6 }}
            animate={visible.includes(i) ? { opacity: 1, x: 0 } : { opacity: 0, x: -6 }}
            transition={{ duration: 0.2 }}
            className={line.color}
          >
            {line.text}
          </motion.div>
        ))}
        {visible.length === TERMINAL_LINES.length && <span className="cursor text-yellow" />}
      </div>
    </div>
  );
}

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-28 px-6" style={{ background: "linear-gradient(180deg, #0B1220 0%, #080E1A 100%)" }}>
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">How Q402 works</h2>
          <p className="text-white/40 max-w-lg mx-auto text-sm leading-relaxed">
            Three addresses. One transaction. Works on any EVM chain — BNB, Ethereum, Avalanche, X Layer.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-2 gap-10 items-start">
          {/* Steps */}
          <div className="space-y-4">
            {steps.map((step, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="card-glow relative group"
                style={{ background: "#0F1929", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "16px", padding: "24px" }}
              >
                {i < steps.length - 1 && (
                  <div className="absolute left-9 -bottom-4 w-px h-4 z-10" style={{ background: `linear-gradient(to bottom, ${step.color}60, transparent)` }} />
                )}
                <div className="flex items-start gap-4">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-navy text-sm flex-shrink-0 mt-0.5" style={{ backgroundColor: step.color }}>
                    {step.label}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center flex-wrap gap-2 mb-2">
                      <h3 className="font-semibold">{step.title}</h3>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border" style={{ color: step.color, borderColor: `${step.color}30`, background: `${step.color}10` }}>
                        {step.tag}
                      </span>
                    </div>
                    <p className="text-white/40 text-sm leading-relaxed">{step.description}</p>
                  </div>
                </div>
              </motion.div>
            ))}

            <motion.div
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.4 }}
              style={{ background: "#0F1929", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "16px", padding: "20px" }}
              className="flex items-center gap-4"
            >
              <div className="flex gap-2">
                {[
                  { label: "BNB",  img: "/bnb.png",     bg: "#F0B90B" },
                  { label: "ETH",  img: "/eth.png",     bg: "#1A1F36" },
                  { label: "AVAX", img: "/avax.png",    bg: "#E84142" },
                  { label: "X",    img: "/xlayer.png",  bg: "#1A1A1A" },
                ].map((c) => (
                  <div key={c.label} className="w-7 h-7 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0" style={{ backgroundColor: c.bg }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.img} alt={c.label} className="w-7 h-7 object-cover" />
                  </div>
                ))}
              </div>
              <p className="text-white/40 text-xs">
                <span className="text-white/70 font-medium">Same protocol, any EVM chain.</span> Switch with one parameter.
              </p>
            </motion.div>
          </div>

          {/* Typing terminal */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <TypingTerminal />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
