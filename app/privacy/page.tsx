export const metadata = { title: "Privacy Policy — Q402" };

const EFFECTIVE_DATE = "April 9, 2026";
const COMPANY = "Quack AI";
const EMAIL = "davidlee@quackai.ai";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#0d1422] text-white/80 py-20 px-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
        <p className="text-white/30 text-sm mb-12">Effective date: {EFFECTIVE_DATE}</p>

        <div className="space-y-10 text-sm leading-relaxed">

          <section>
            <h2 className="text-white font-semibold text-base mb-3">1. Who We Are</h2>
            <p>
              {COMPANY} operates the Q402 gasless payment relay protocol at
              q402-institutional.vercel.app. This policy describes what data we collect, how we use it,
              and your rights regarding that data.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">2. What We Collect</h2>

            <h3 className="text-white/70 font-medium mb-2">A. Account Data</h3>
            <ul className="list-disc list-inside space-y-1 mb-4">
              <li>Blockchain wallet address (your public key — not a secret)</li>
              <li>API key (hashed reference, stored in Vercel KV)</li>
              <li>Subscription plan, payment TX hash, activation date</li>
            </ul>

            <h3 className="text-white/70 font-medium mb-2">B. Transaction Data</h3>
            <ul className="list-disc list-inside space-y-1 mb-4">
              <li>Relayed transaction hashes, chain, token, amount, timestamp</li>
              <li>Gas cost per relay (native token amount)</li>
              <li>Sender and recipient wallet addresses (public blockchain data)</li>
            </ul>

            <h3 className="text-white/70 font-medium mb-2">C. Inquiry / Contact Data</h3>
            <ul className="list-disc list-inside space-y-1 mb-4">
              <li>App name, website, email, Telegram handle (if submitted via inquiry form)</li>
              <li>Project description and expected usage volume</li>
            </ul>

            <h3 className="text-white/70 font-medium mb-2">D. Technical Data</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>IP address (for rate limiting — not stored long-term)</li>
              <li>Vercel edge function logs (retained per Vercel&apos;s standard policy)</li>
              <li>Webhook URL and configuration (stored in Vercel KV)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">3. What We Do NOT Collect</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Private keys — we never ask for, store, or have access to any private keys</li>
              <li>Passwords — authentication is signature-based (EIP-191), no passwords exist</li>
              <li>Personal identity information (name, ID, address) — not required</li>
              <li>Browser cookies for tracking — we use no third-party analytics cookies</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">4. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-2">
              <li><strong className="text-white/60">Service delivery</strong> — validate API keys, enforce quotas, process relay requests</li>
              <li><strong className="text-white/60">Billing</strong> — verify on-chain subscription payments and activate accounts</li>
              <li><strong className="text-white/60">Support</strong> — respond to inquiry form submissions</li>
              <li><strong className="text-white/60">Security</strong> — rate limiting, abuse detection, replay attack prevention</li>
              <li><strong className="text-white/60">Transparency</strong> — provide you with your own transaction history via the dashboard</li>
            </ul>
            <p className="mt-3">
              We do not sell, rent, or share your data with third parties for marketing purposes.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">5. Data Storage</h2>
            <p className="mb-3">
              All structured data (subscriptions, API keys, transaction history, webhook config) is
              stored in <strong className="text-white/60">Vercel KV (Redis)</strong>, hosted on Vercel&apos;s
              infrastructure. Vercel&apos;s data centers are located in the US and EU regions.
            </p>
            <p>
              Inquiry form submissions may be forwarded to a Telegram channel operated by {COMPANY} for
              internal review. No third-party CRM or marketing tools receive this data.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">6. Data Retention</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Subscription and API key records: retained while active + 90 days after expiry</li>
              <li>Transaction history: retained in monthly KV keys, up to 10,000 entries per month</li>
              <li>Inquiry data: retained until actioned or deleted upon request</li>
              <li>Rate limit counters: expire automatically (60s – 600s window per endpoint)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">7. Blockchain Data</h2>
            <p>
              Wallet addresses, transaction hashes, and token amounts submitted to the relay are
              recorded on public blockchains. This data is immutable and outside Q402&apos;s control.
              By using the relay service, you acknowledge that on-chain transaction data is permanently
              and publicly visible.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">8. Webhook Data</h2>
            <p>
              If you register a webhook, Q402 will send relay event payloads (including transaction
              details) to your specified URL. You are responsible for the security and handling of
              webhook data on your server. Q402 signs all webhook payloads with HMAC-SHA256; verify
              the signature before processing.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">9. Your Rights</h2>
            <p className="mb-3">You may request at any time:</p>
            <ul className="list-disc list-inside space-y-2">
              <li><strong className="text-white/60">Access</strong> — a copy of data we hold associated with your wallet address</li>
              <li><strong className="text-white/60">Deletion</strong> — removal of your subscription record, API keys, and inquiry data</li>
              <li><strong className="text-white/60">Correction</strong> — update your inquiry contact details</li>
            </ul>
            <p className="mt-3">
              Note: on-chain transaction data cannot be deleted. API key deletion will immediately
              terminate service access.
            </p>
            <p className="mt-3">
              To exercise these rights, contact{" "}
              <a href={`mailto:${EMAIL}`} className="text-yellow/80 hover:text-yellow transition-colors">
                {EMAIL}
              </a>{" "}
              with your wallet address.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">10. Third-Party Services</h2>
            <ul className="list-disc list-inside space-y-2">
              <li><strong className="text-white/60">Vercel</strong> — hosting and KV storage (<a href="https://vercel.com/legal/privacy-policy" className="text-yellow/80 hover:text-yellow" target="_blank" rel="noopener noreferrer">Vercel Privacy Policy</a>)</li>
              <li><strong className="text-white/60">Public RPC providers</strong> — on-chain data reads (Avalanche, BSC, Ethereum, X Layer, Stable public endpoints)</li>
              <li><strong className="text-white/60">CoinGecko</strong> — token price data for Gas Tank USD display (no user data sent)</li>
              <li><strong className="text-white/60">Telegram</strong> — internal inquiry notifications only</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">11. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. Material changes will be announced
              via dashboard notice or email (if provided). Continued use of the service after changes
              take effect constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">12. Contact</h2>
            <p>
              Privacy questions or data requests:{" "}
              <a href={`mailto:${EMAIL}`} className="text-yellow/80 hover:text-yellow transition-colors">
                {EMAIL}
              </a>
            </p>
          </section>

        </div>

        <div className="mt-16 pt-8 border-t border-white/8 flex items-center justify-between text-xs text-white/20">
          <span>© 2026 {COMPANY}. All rights reserved.</span>
          <a href="/terms" className="hover:text-white/50 transition-colors">Terms of Service →</a>
        </div>
      </div>
    </div>
  );
}
