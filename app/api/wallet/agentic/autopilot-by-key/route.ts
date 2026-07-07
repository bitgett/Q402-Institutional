/**
 * POST /api/wallet/agentic/autopilot-by-key
 *
 * Q402 Autopilot rule CRUD + dry-run, authenticated by apiKey (Mode C).
 * Actions:
 *   create   — author a rule (GATED behind AUTOPILOT_ENABLED; 503 when off)
 *   preview  — dry-run: evaluate a proposed OR existing rule, zero side effects
 *   list     — list the wallet's rules
 *   pause    — pause a rule (reversible)
 *   resume   — re-activate a paused rule
 *   cancel   — cancel a rule (terminal)
 *   fires    — recent fire log for one rule
 *   vendors  — set the approved-vendor allowlist (for vendor-invoice conditions)
 *
 * The watcher cron does the actual firing by calling the hardened Mode-C send /
 * yield endpoints; this route only manages rules and previews them.
 */
import { NextRequest, NextResponse } from "next/server";
import { getApiKeyRecord } from "@/app/lib/db";
import { rateLimit, getClientIP } from "@/app/lib/ratelimit";
import { resolveWallet } from "@/app/lib/agentic-wallet";
import {
  autopilotEnabled,
  createAutopilotRule,
  listAutopilotRules,
  getAutopilotRule,
  setAutopilotStatus,
  listAutopilotFires,
  setApprovedVendors,
  getApprovedVendors,
  evaluateRule,
  type AutopilotCondition,
  type AutopilotAction,
  type AutopilotRule,
} from "@/app/lib/autopilot";

export const runtime = "nodejs";
export const maxDuration = 30;

function parseCondition(c: unknown): AutopilotCondition | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (o.kind === "idle-balance" && typeof o.chain === "string" && (o.token === "USDC" || o.token === "USDT") && typeof o.over === "number" && o.over >= 0)
    return { kind: "idle-balance", chain: o.chain, token: o.token, over: o.over };
  if (o.kind === "weekly-spend-pct" && typeof o.capUsd === "number" && o.capUsd > 0 && typeof o.pct === "number" && o.pct > 0 && o.pct <= 100)
    return { kind: "weekly-spend-pct", capUsd: o.capUsd, pct: o.pct };
  if (o.kind === "vendor-invoice" && typeof o.maxUsd === "number" && o.maxUsd > 0)
    return { kind: "vendor-invoice", maxUsd: o.maxUsd };
  return null;
}
function parseAction(a: unknown): AutopilotAction | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  if (o.kind === "move-to-yield" && typeof o.amount === "number" && o.amount > 0 && (o.token === "USDC" || o.token === "USDT") && typeof o.chain === "string")
    return { kind: "move-to-yield", amount: o.amount, token: o.token, chain: o.chain, ...(typeof o.protocol === "string" ? { protocol: o.protocol } : {}) };
  if (o.kind === "auto-pay") return { kind: "auto-pay" };
  if (o.kind === "pause") return { kind: "pause" };
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIP(req);
  if (!(await rateLimit(ip, "agentic-autopilot-by-key", 15, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Autopilot ships DARK. Until AUTOPILOT_ENABLED=1 the ENTIRE surface is inert
  // (not just create) — no rule can be authored, previewed, listed, or inspected
  // in production. The dark foundation stays in the tree; this gate keeps it off.
  if (!autopilotEnabled()) {
    return NextResponse.json({ error: "AUTOPILOT_DISABLED", message: "Autopilot is not enabled yet." }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ error: "API_KEY_REQUIRED" }, { status: 400 });
  if (apiKey.startsWith("q402_test_") || apiKey.startsWith("q402_sandbox_")) {
    return NextResponse.json({ error: "SANDBOX_KEY_REJECTED" }, { status: 401 });
  }
  const rec = await getApiKeyRecord(apiKey);
  if (!rec || !rec.active || rec.isSandbox) return NextResponse.json({ error: "INVALID_API_KEY" }, { status: 401 });
  const owner = rec.address.toLowerCase();

  const walletIdIn = typeof body.walletId === "string" && body.walletId ? body.walletId.toLowerCase() : undefined;
  const wallet = await resolveWallet(owner, walletIdIn ?? null);
  if (!wallet) return NextResponse.json({ error: "AGENTIC_WALLET_NOT_FOUND" }, { status: 404 });
  const walletId = wallet.address.toLowerCase();
  const action = body.action;

  try {
    switch (action) {
      case "list":
        return NextResponse.json({ walletId, rules: await listAutopilotRules(owner, walletId), approvedVendors: await getApprovedVendors(owner, walletId) });

      case "fires": {
        const id = typeof body.ruleId === "string" ? body.ruleId : "";
        if (!id) return NextResponse.json({ error: "RULE_ID_REQUIRED" }, { status: 400 });
        const rule = await getAutopilotRule(owner, walletId, id);
        if (!rule) return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
        return NextResponse.json({ walletId, ruleId: id, rule, fires: await listAutopilotFires(owner, walletId, id) });
      }

      case "vendors": {
        const vendors = Array.isArray(body.vendors) ? body.vendors.filter((v): v is string => typeof v === "string") : [];
        await setApprovedVendors(owner, walletId, vendors);
        return NextResponse.json({ walletId, approvedVendors: await getApprovedVendors(owner, walletId) });
      }

      case "preview": {
        // Dry-run: an existing rule by id, or a proposed condition+action.
        let rule: AutopilotRule | null = null;
        if (typeof body.ruleId === "string" && body.ruleId) {
          rule = await getAutopilotRule(owner, walletId, body.ruleId);
          if (!rule) return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
        } else {
          const condition = parseCondition(body.condition);
          const act = parseAction(body.action_) ?? parseAction(body.plan);
          if (!condition || !act) return NextResponse.json({ error: "INVALID_RULE", message: "preview needs a valid condition + action (or a ruleId)" }, { status: 400 });
          rule = {
            id: "preview", ownerAddr: owner, walletId, label: null, status: "active",
            condition, action: act, createdAt: Date.now(), nextRunAt: 0, lastFiredAt: null,
            totalFiredCount: 0, totalMovedUsd: 0, lastError: null,
            ...(typeof body.keepLiquidUsd === "number" ? { keepLiquidUsd: body.keepLiquidUsd } : {}),
          };
        }
        const evalResult = await evaluateRule(rule, wallet.address);
        return NextResponse.json({ walletId, ruleId: rule.id === "preview" ? null : rule.id, dryRun: true, ...evalResult });
      }

      case "pause":
      case "resume":
      case "cancel": {
        const id = typeof body.ruleId === "string" ? body.ruleId : "";
        if (!id) return NextResponse.json({ error: "RULE_ID_REQUIRED" }, { status: 400 });
        const status = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
        const rule = await setAutopilotStatus(owner, walletId, id, status);
        if (!rule) return NextResponse.json({ error: "RULE_NOT_FOUND" }, { status: 404 });
        return NextResponse.json({ walletId, rule });
      }

      case "create": {
        if (!autopilotEnabled()) {
          return NextResponse.json({ error: "AUTOPILOT_DISABLED", message: "Autopilot is not enabled yet. Rules can be previewed but not created." }, { status: 503 });
        }
        const condition = parseCondition(body.condition);
        const act = parseAction(body.action_);
        if (!condition || !act) return NextResponse.json({ error: "INVALID_RULE", message: "create needs a valid condition + action_" }, { status: 400 });
        // Guardrail: a condition/action mismatch cannot fire.
        if (condition.kind === "idle-balance" && act.kind !== "move-to-yield") return NextResponse.json({ error: "MISMATCH", message: "idle-balance requires a move-to-yield action" }, { status: 400 });
        if (condition.kind === "vendor-invoice" && act.kind !== "auto-pay") return NextResponse.json({ error: "MISMATCH", message: "vendor-invoice requires an auto-pay action" }, { status: 400 });
        try {
          const rule = await createAutopilotRule({
            ownerAddr: owner, walletId, label: typeof body.label === "string" ? body.label : null,
            condition, action: act, ...(typeof body.keepLiquidUsd === "number" ? { keepLiquidUsd: body.keepLiquidUsd } : {}),
          });
          return NextResponse.json({ walletId, rule }, { status: 201 });
        } catch (e) {
          if (e instanceof Error && e.message === "MAX_RULES_REACHED") return NextResponse.json({ error: "MAX_RULES_REACHED" }, { status: 409 });
          throw e;
        }
      }

      default:
        return NextResponse.json({ error: "INVALID_ACTION", message: "action must be create | preview | list | pause | resume | cancel | fires | vendors" }, { status: 400 });
    }
  } catch (e) {
    console.error("[autopilot-by-key]", e);
    return NextResponse.json({ error: "autopilot_failed" }, { status: 502 });
  }
}
