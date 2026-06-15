'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const CHECKS = [
  {
    n: '01',
    title: 'Intent, signed by the payer',
    body: 'Recipient, token, amount, chain, nonce, and deadline are bound before execution.',
  },
  {
    n: '02',
    title: 'EIP-7702 owner-binding',
    body: 'Delegated execution is bound to the signer and the guarded implementation.',
  },
  {
    n: '03',
    title: 'Sandbox by default',
    body: 'q402_test_ keys simulate the flow. No broadcast, no funds, no live webhook.',
  },
  {
    n: '04',
    title: 'Fully on-chain verifiable',
    body: 'Confirm the settlement independently on the chain explorer and with its Trust Receipt.',
  },
];

function Seal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.1 2.3 2.3 4.9-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const LIFECYCLE = ['Signed', 'Relayed', 'Settled', 'Receipt'];

function Experience() {
  return (
    <div className="kp-shell">
      <div className="c1-shead c1-in">
        <span className="c1-kick"><span className="c1-kick-n">04</span>Trust &amp; security</span>
        <h2 className="c1-stitle">Trust is visible, not implied.</h2>
        <p className="c1-sub">Every live payment is bound, checked, and independently verifiable.</p>
      </div>

      <div className="kp-stage">
        <div className="kp-checks" aria-label="Q402 verification guarantees">
          {CHECKS.map((check) => (
            <div className="kp-check kp-check-done" key={check.n}>
              <span className="kp-num">{check.n}</span>
              <span className="kp-copy">
                <strong>{check.title}</strong>
                <span>{check.body}</span>
              </span>
              <span className="kp-state" aria-label="verified">✓</span>
            </div>
          ))}
        </div>

        <div className="kp-proof kp-proof-yellow">
          <div className="kp-grid" aria-hidden />
          <div className="kp-orbit kp-orbit-a" aria-hidden />
          <div className="kp-orbit kp-orbit-b" aria-hidden />

          <div className="kp-top">
            <div className="kp-live"><i /> TRUST RECEIPT</div>
            <div className="kp-id">rct_8f2a…d91e</div>
          </div>

          <div className="kp-rail" aria-label="Settlement lifecycle, complete">
            {LIFECYCLE.map((stage, index) => (
              <div className="kp-step kp-step-on" key={stage}>
                <span className="kp-node">✓</span>
                <span className="kp-step-label">{stage}</span>
                {index < LIFECYCLE.length - 1 ? <i className="kp-link" /> : null}
              </div>
            ))}
          </div>

          <div className="kp-core">
            <div className="kp-result">
              <span className="kp-seal">
                <i />
                <Seal />
              </span>
              <span>
                <small>SETTLEMENT VERIFIED</small>
                <strong>RECEIPT VERIFIED</strong>
                <code>4 / 4 checks passed · block 103,407,398</code>
              </span>
            </div>

            <div className="kp-data">
              <div><span>Asset</span><b><img src="/usdc.svg" alt="" />50.00 USDC</b></div>
              <div><span>Network</span><b>BNB Chain · 56</b></div>
              <div><span>Payer gas</span><b>$0.000000</b></div>
              <div><span>Finality</span><b>412 ms</b></div>
            </div>
          </div>

          <div className="kp-foot">
            <div className="kp-proof-tags">
              <span><i />On-chain</span>
              <span>Signer match</span>
              <span>Receipt valid</span>
            </div>
            <span className="kp-tx">tx 0x1b65…b80e ↗</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SecurityPreview() {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const section = Array.from(document.querySelectorAll<HTMLElement>('.c1-section')).find((candidate) =>
      candidate.querySelector('.c1-kick')?.textContent?.includes('Trust & security'),
    );
    const target = section?.querySelector<HTMLElement>('.c1-wrap');
    if (!target) return;

    const mount = document.createElement('div');
    mount.className = 'kp-mount';
    target.classList.add('kp-target');
    target.appendChild(mount);
    const frame = requestAnimationFrame(() => setHost(mount));

    return () => {
      cancelAnimationFrame(frame);
      mount.remove();
      target.classList.remove('kp-target');
    };
  }, []);

  return (
    <>
      <style>{`
        .kp-target > :not(.kp-mount){display:none!important}
        .kp-shell{padding:0}
        .kp-stage{display:grid;grid-template-columns:minmax(310px,.82fr) minmax(0,1.18fr);gap:28px;margin-top:30px;align-items:stretch}
        .kp-checks{display:flex;flex-direction:column;gap:14px}
        .kp-check{width:100%;display:grid;grid-template-columns:auto 1fr auto;gap:14px;position:relative;overflow:hidden;text-align:left;padding:17px 16px;border:1px solid rgba(255,255,255,.07);border-radius:14px;color:inherit;background:rgba(255,255,255,.015)}
        .kp-check-done{border-color:rgba(245,197,24,.16);background:linear-gradient(90deg,rgba(245,197,24,.045),transparent)}
        .kp-num{font-family:var(--mono);font-weight:700;font-size:11px;color:var(--acc2);padding-top:3px}
        .kp-copy{display:flex;flex-direction:column}
        .kp-copy strong{font-family:var(--disp);font-weight:700;font-size:15.5px;letter-spacing:-.02em;margin-bottom:4px}
        .kp-copy span{color:var(--mut);font-size:12.5px;line-height:1.5;max-width:48ch}
        .kp-state{width:21px;height:21px;border-radius:50%;border:1px solid rgba(245,197,24,.4);display:grid;place-items:center;margin-top:1px;color:var(--acc);font-family:var(--mono);font-size:11px;font-weight:700;box-shadow:0 0 10px rgba(245,197,24,.22)}
        .kp-proof{position:relative;overflow:hidden;display:flex;flex-direction:column;border:1px solid rgba(91,200,250,.2);border-radius:20px;background:radial-gradient(circle at 72% 42%,rgba(91,200,250,.09),transparent 34%),linear-gradient(155deg,rgba(10,22,40,.96),rgba(5,10,19,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 30px 80px -45px rgba(22,145,215,.55)}
        .kp-grid{position:absolute;inset:0;opacity:.28;background-image:linear-gradient(rgba(91,200,250,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(91,200,250,.06) 1px,transparent 1px);background-size:36px 36px;mask-image:linear-gradient(to bottom,black,transparent 92%)}
        .kp-orbit{position:absolute;border:1px solid rgba(91,200,250,.12);border-radius:50%;pointer-events:none}
        .kp-orbit-a{width:330px;height:330px;right:-116px;top:78px;animation:kpOrbit 18s linear infinite}
        .kp-orbit-b{width:220px;height:220px;right:-62px;top:132px;border-style:dashed;animation:kpOrbit 13s linear reverse infinite}
        @keyframes kpOrbit{to{transform:rotate(360deg)}}
        .kp-top{height:62px;position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid rgba(255,255,255,.07)}
        .kp-live,.kp-id{font-family:var(--mono);font-size:10px;letter-spacing:.12em}
        .kp-live{color:var(--acc2);display:flex;align-items:center;gap:8px}
        .kp-live i,.kp-foot i{width:6px;height:6px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px rgba(245,197,24,.9);animation:kpBlink 1.5s ease-in-out infinite}
        @keyframes kpBlink{50%{opacity:.35}}
        .kp-id{color:var(--mut)}
        .kp-rail{position:relative;z-index:3;display:grid;grid-template-columns:repeat(4,1fr);padding:22px 22px 15px}
        .kp-step{position:relative;z-index:2;display:flex;flex-direction:column;align-items:flex-start;gap:7px;font-family:var(--mono);font-size:8.5px;letter-spacing:.07em;text-transform:uppercase;color:rgba(226,235,247,.76);transition:color .35s}
        .kp-step-on{color:var(--ink)}
        .kp-step-label{position:relative;z-index:4;display:inline-flex;align-items:center;min-height:16px;white-space:nowrap;text-shadow:0 1px 8px #07101d,0 0 18px #07101d}
        .kp-node{width:28px;height:28px;display:grid;place-items:center;position:relative;z-index:2;border-radius:50%;border:1px solid rgba(255,255,255,.12);background:#0a1220;color:var(--mut2);transition:all .35s}
        .kp-step-on .kp-node{color:#06101b;border-color:var(--acc2);background:var(--acc2);box-shadow:0 0 0 5px rgba(91,200,250,.09),0 0 22px rgba(91,200,250,.35)}
        .kp-link{position:absolute;z-index:1;height:1px;left:28px;right:0;top:14px;background:rgba(255,255,255,.1)}
        .kp-step-on .kp-link{background:linear-gradient(90deg,var(--acc2),rgba(91,200,250,.1))}
        .kp-core{position:relative;z-index:2;width:calc(100% - 92px);max-width:610px;margin:auto auto 0;border:1px solid rgba(255,255,255,.08);border-radius:15px;overflow:hidden;background:rgba(3,8,16,.72);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
        .kp-scan{position:absolute;z-index:0;left:0;right:0;height:48px;top:-48px;pointer-events:none;background:linear-gradient(180deg,transparent,rgba(91,200,250,.045),rgba(91,200,250,.13),transparent);animation:kpScan 3.2s ease-in-out infinite}
        @keyframes kpScan{0%{top:-48px}75%,100%{top:100%}}
        .kp-result{min-height:108px;position:relative;z-index:1;display:flex;align-items:center;justify-content:flex-start;gap:18px;padding:20px 30px;border-bottom:1px solid var(--hair)}
        .kp-seal{width:38px;height:38px;flex:0 0 38px;position:relative;display:grid;place-items:center;color:var(--acc2);transition:color .3s}
        .kp-seal:before,.kp-seal:after,.kp-seal i{content:"";position:absolute;border-radius:50%;inset:0;border:1px solid currentColor;opacity:.28}
        .kp-seal:before{animation:kpSealPulse 2.2s ease-out infinite}
        .kp-seal:after{inset:6px;opacity:.2}
        .kp-seal i{inset:12px;border:0;background:currentColor;opacity:.13;box-shadow:0 0 18px currentColor}
        .kp-seal svg{position:relative;z-index:2;width:18px;height:18px}
        @keyframes kpSealPulse{0%{transform:scale(.75);opacity:.55}70%,100%{transform:scale(1.45);opacity:0}}
        .kp-result small{display:block;font-family:var(--mono);font-size:9px;letter-spacing:.14em;color:var(--mut2);margin-bottom:5px}
        .kp-result strong{display:block;font-family:var(--disp);font-size:18px;letter-spacing:.02em;color:var(--ink)}
        .kp-result code{display:block;margin-top:4px;font-family:var(--mono);font-size:11px;color:var(--acc2)}
        .kp-data{position:relative;z-index:1;display:grid;grid-template-columns:1fr 1fr}
        .kp-data div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-right:1px solid var(--hair);border-bottom:1px solid var(--hair);font-size:11.5px}
        .kp-data div:nth-child(2n){border-right:0}.kp-data div:nth-last-child(-n+2){border-bottom:0}
        .kp-data span{color:var(--mut2)}.kp-data b{font-family:var(--mono);font-weight:500;color:var(--ink);display:flex;align-items:center;gap:6px}
        .kp-data img{width:15px;height:15px}
        .kp-foot{position:relative;z-index:2;margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 22px;font-family:var(--mono);font-size:9px;color:var(--mut)}
        .kp-proof-tags{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
        .kp-proof-tags span{display:flex;align-items:center;gap:7px;padding:6px 9px;border:1px solid rgba(245,197,24,.16);border-radius:999px;background:rgba(245,197,24,.05);color:#f1cf63;text-transform:uppercase;letter-spacing:.06em}
        .kp-tx{white-space:nowrap}
        .kp-proof-yellow{border-color:rgba(245,197,24,.26);background:radial-gradient(circle at 74% 40%,rgba(245,197,24,.10),transparent 36%),radial-gradient(circle at 18% 92%,rgba(91,200,250,.07),transparent 42%),linear-gradient(155deg,rgba(14,20,34,.96),rgba(6,10,17,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 30px 80px -45px rgba(214,170,30,.5)}
        .kp-proof-yellow .kp-seal{color:var(--acc)}.kp-proof-yellow .kp-result code{color:var(--acc)}
        .kp-proof-blue .kp-seal{color:#8b8cff}.kp-proof-blue .kp-result code{color:#a9aaff}
        @media(max-width:900px){.kp-stage{grid-template-columns:1fr;gap:22px}.kp-proof{aspect-ratio:auto;min-height:438px}}
        @media(max-width:620px){.kp-check{padding:14px 12px}.kp-proof{min-height:420px}.kp-step{font-size:0}.kp-step-label{display:none}.kp-rail{padding-inline:15px}.kp-core{width:calc(100% - 30px)}.kp-result{justify-content:flex-start;padding-inline:18px}.kp-data{grid-template-columns:1fr}.kp-data div,.kp-data div:nth-child(2n){border-right:0;border-bottom:1px solid var(--hair)}.kp-data div:last-child{border-bottom:0}.kp-foot{align-items:flex-start;flex-direction:column}.kp-proof-tags{gap:5px}.kp-tx{white-space:normal;line-height:1.45}}
        @media(prefers-reduced-motion:reduce){.kp-orbit,.kp-scan,.kp-live i,.kp-progress,.kp-seal:before{animation:none}}
      `}</style>
      {host ? createPortal(<Experience />, host) : null}
    </>
  );
}
