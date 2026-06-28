# Lista BD — follow-up message (final)

Status: integration built + audited on our side; launch vault chosen (Gauntlet USDT).
Send after the intro. Plain text, no markdown needed.

---

Subject: Q402 x Lista Lending — gasless agent deposits into the Gauntlet USDT Vault (BNB)

Hi [name],

Great to be connected, and thanks for the intro. Since the first note we built and
internally audited the integration end to end, so this is concrete.

What we are building. Inside Q402 Agent Wallets, an AI agent (or its owner) can supply
and withdraw idle USDT into Lista Lending gaslessly: the agent signs off chain
(EIP-712 + EIP-7702) and our relayer sponsors gas, so the full supply/withdraw round
trip costs the user zero gas. It is an explicit deposit/withdraw the agent controls,
not an auto-sweep, and the agent never picks a chain or vault: we abstract that and
route to Lista on BNB, our home chain.

Why it is small on both sides. We already run this exact gasless ERC-4626 supply/withdraw
adapter on Base into a Gauntlet-curated MetaMorpho vault. We verified on-chain that your
MoolahVault is the same ERC-4626 interface (deposit / withdraw / redeem / maxWithdraw), so
on our end this was "add the vault to our allowlist and ship the BNB impl," not a new
build. For launch we route USDT to the Gauntlet USDT Vault
(0x6d6783C146F2B0B2774C1725297f1845dc502525) — same curator as our Base vault, ~$8M TVL,
deepest USDT liquidity for instant pull-back. We read maxWithdraw before each withdraw, so
high-utilization periods degrade gracefully rather than failing.

What it gives Lista. A new deposit channel that is not human depositors: autonomous AI
agents parking idle stablecoins, scaling with agent adoption. BNB native, day one.

A few questions:
1. Is the Gauntlet USDT Vault the right launch target, or would you steer us to a
   different USDT vault? Any per-vault deposit caps we should know about?
2. We also wired USDC. We found what looks like your Lista USDC Vault
   (0x8a06Ac91265dBEBE6D4606f45b10993E9a571869, ~$330K TVL) by on-chain trace since it is
   not in the public docs. Can you confirm that is the right/official USDC vault to route
   into?
3. Is there a Lista API for live vault APY we can read for our dashboard?

Co-marketing. We would love a joint launch to our agent and developer audience. Q402
ships as an MCP server on npm and Anthropic's MCP Registry, so we can demo a Claude or
Cursor agent depositing into Lista on BNB gasless, live — a new "AI agent depositor"
category on top of your curator-network story.

Timeline. The path is already built and audited on our side; once we confirm the routing
vault and interface with you, we expect to be live (smoke-tested) within about three days.

Happy to jump on a call this week, and to walk your team through the adapter + a working
read against the Gauntlet USDT Vault so you can see exactly how it plugs in.

Best,
David
Quack AI / Q402
