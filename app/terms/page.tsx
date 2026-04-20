export const metadata = { title: "Terms of Service — Q402" };

const EFFECTIVE_DATE = "April 9, 2026";
const COMPANY = "Quack AI";
const EMAIL = "davidlee@quackai.ai";
export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0d1422] text-white/80 py-20 px-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-2">Terms of Service</h1>
        <p className="text-white/30 text-sm mb-12">Effective date: {EFFECTIVE_DATE}</p>

        <div className="space-y-10 text-sm leading-relaxed">

          <section>
            <h2 className="text-white font-semibold text-base mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using the Q402 gasless payment relay service, APIs, SDKs, or any related
              software provided by {COMPANY} (&ldquo;Q402&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;),
              you (&ldquo;Customer&rdquo;, &ldquo;you&rdquo;) agree to be bound by these Terms of Service.
              If you do not agree, do not use the service.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">2. Description of Service</h2>
            <p className="mb-3">
              Q402 provides a gasless ERC-20 payment relay infrastructure. Customers integrate the Q402
              SDK or API to allow their end-users to transfer USDC/USDT on supported EVM chains without
              holding native gas tokens. Q402&apos;s relayer wallet pays all on-chain transaction fees
              on the customer&apos;s behalf.
            </p>
            <p>
              Supported chains include Avalanche, BNB Chain, Ethereum, X Layer, and Stable (subject to
              change). Q402 does not custody, hold, or control any customer or end-user funds at any time.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">3. API Keys &amp; Accounts</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>API keys are issued to the blockchain address that completes on-chain payment verification.</li>
              <li>You are responsible for keeping your API key confidential. Do not expose keys in client-side code or public repositories.</li>
              <li>You may rotate your API key at any time via the dashboard. The old key is immediately revoked.</li>
              <li>Q402 reserves the right to revoke API keys that violate these terms without prior notice.</li>
              <li>Accounts are non-transferable. You may not sell, resell, or sublicense access to the Q402 API.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">4. Subscription &amp; Payment</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Subscriptions are activated via on-chain USDC/USDT payment to the Q402 payment address.</li>
              <li>All payments are final and non-refundable once on-chain confirmation is received.</li>
              <li>Each paid purchase grants a 30-day access window plus the transaction credits listed for the selected tier. Credits accumulate across renewals; access days stack if you renew before expiry.</li>
              <li>Your plan level is determined by cumulative paid amount within an active 30-day window, normalized to BNB Chain base pricing (Ethereum and Avalanche payments are converted at the published chain multiplier). When cumulative spend crosses a higher tier&apos;s threshold, your plan upgrades automatically. Plans never downgrade while the window is active. If the window lapses (no payment for 30 days after the last renewal), cumulative resets and the next payment establishes a new window.</li>
              <li>Transaction credits are enforced as stated on the pricing page at purchase time.</li>
              <li>Q402 reserves the right to change pricing with 14 days&apos; notice via email or dashboard notification.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">5. Gas Tank</h2>
            <p className="mb-3">
              Some plans require customers to pre-fund a Gas Tank by depositing native tokens (BNB, ETH,
              AVAX, OKB, or USDT0) to the Q402 Gas Tank address displayed per-chain in your Dashboard →
              Gas Tank tab. Do not send Gas Tank deposits to the relayer (signer) address. These deposits
              are used exclusively to cover on-chain gas costs for your relayed transactions.
            </p>
            <p className="mb-3">
              Gas Tank balances are non-refundable except by explicit arrangement with Q402 support.
              Q402 is not liable for relay failures caused by insufficient Gas Tank balance.
            </p>
            <p>
              For the Stable chain, USDT0 serves as both the gas token and payment token. Gas Tank
              deposits on Stable must be made in USDT0.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">6. Acceptable Use</h2>
            <p className="mb-3">You agree NOT to use Q402 to:</p>
            <ul className="list-disc list-inside space-y-2">
              <li>Facilitate transactions that violate applicable laws or regulations in any jurisdiction.</li>
              <li>Process payments for sanctioned individuals, entities, or countries (OFAC, EU, UN sanction lists).</li>
              <li>Conduct money laundering, terrorist financing, or any other financial crime.</li>
              <li>Attempt to manipulate, exploit, or abuse the relay infrastructure (e.g., replay attacks, signature forgery).</li>
              <li>Exceed your plan&apos;s relay quota through artificial inflation or coordinated abuse across multiple keys.</li>
              <li>Resell or white-label Q402 relay infrastructure without a separate written agreement.</li>
            </ul>
            <p className="mt-3">
              Q402 reserves the right to suspend service immediately upon detection of prohibited use.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">7. Rate Limits &amp; Quotas</h2>
            <p>
              Each purchase includes a fixed number of transaction credits and per-IP API rate limits.
              Credits are consumed per successful relay and persist until used or the 30-day access
              window expires. Exhausting credits suspends relay until you top up with an additional
              purchase on the pricing page. Q402 may adjust limits at any time to protect
              infrastructure stability.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">8. Webhooks</h2>
            <p>
              Webhook delivery is best-effort. Q402 does not guarantee delivery of webhook events in the
              event of your server downtime, network failures, or misconfiguration. Q402 is not liable
              for business logic failures resulting from missed webhook events. You should reconcile
              transaction state using the <code className="text-yellow/80">/api/transactions</code> endpoint
              as the source of truth.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">9. Sandbox Mode</h2>
            <p>
              Sandbox API keys (<code className="text-yellow/80">q402_test_</code> prefix) do not submit
              on-chain transactions. Sandbox responses are simulated and must not be used as evidence of
              real payment settlement. Q402 is not liable for any claims arising from sandbox transactions
              being treated as real.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">10. No Custody / Non-Custodial</h2>
            <p>
              Q402 is a non-custodial relay protocol. Q402 does not hold, control, or have access to
              customer or end-user funds. All token transfers occur directly between the end-user&apos;s
              wallet and the recipient via EIP-7702 delegation. Q402 is not a money transmitter, payment
              processor, or financial institution.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">11. Disclaimers &amp; Limitation of Liability</h2>
            <p className="mb-3">
              THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; WITHOUT WARRANTY OF ANY KIND. Q402 DOES NOT
              WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT RELAY TRANSACTIONS
              WILL SUCCEED ON ALL CHAINS AT ALL TIMES.
            </p>
            <p className="mb-3">
              BLOCKCHAIN NETWORKS ARE OUTSIDE Q402&apos;S CONTROL. Q402 IS NOT LIABLE FOR FAILED
              TRANSACTIONS DUE TO NETWORK CONGESTION, CHAIN OUTAGES, CONTRACT BUGS, OR CHANGES IN
              EIP-7702 SUPPORT BY CHAIN VALIDATORS.
            </p>
            <p>
              IN NO EVENT SHALL Q402&apos;S AGGREGATE LIABILITY EXCEED THE AMOUNT YOU PAID FOR THE
              SERVICE IN THE 30 DAYS PRECEDING THE CLAIM.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">12. Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless {COMPANY} and its officers, directors, and
              employees from any claims, damages, or expenses (including legal fees) arising from your
              use of the service, your violation of these terms, or your end-users&apos; transactions
              processed through your integration.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">13. Modifications to Terms</h2>
            <p>
              Q402 may update these Terms at any time. Material changes will be communicated via email
              or dashboard notice at least 7 days before taking effect. Continued use of the service
              after the effective date constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">14. Governing Law</h2>
            <p>
              These Terms are governed by and construed in accordance with applicable laws. Any disputes
              shall be resolved by binding arbitration. Nothing in these Terms limits either party&apos;s
              ability to seek injunctive or other equitable relief.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-base mb-3">15. Contact</h2>
            <p>
              Questions about these Terms:{" "}
              <a href={`mailto:${EMAIL}`} className="text-yellow/80 hover:text-yellow transition-colors">
                {EMAIL}
              </a>
            </p>
          </section>

        </div>

        <div className="mt-16 pt-8 border-t border-white/8 flex items-center justify-between text-xs text-white/20">
          <span>© 2026 {COMPANY}. All rights reserved.</span>
          <a href="/privacy" className="hover:text-white/50 transition-colors">Privacy Policy →</a>
        </div>
      </div>
    </div>
  );
}
