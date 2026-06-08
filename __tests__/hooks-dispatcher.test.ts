/**
 * hooks-dispatcher.test.ts
 *
 * Exercises the Q402 Hook dispatcher's full decision matrix in
 * isolation — no KV, no routes, fabricated hooks injected via the
 * `runHooks(lifecycle, ctx, hooks)` parameter. Phase 0 ships ZERO
 * real hooks, so this is the only thing proving the framework is
 * correct before Phase 1 wires it into the send route.
 */

import { describe, it, expect } from "vitest";
import { runHooks } from "@/app/lib/hooks/registry";
import type {
  Hook,
  HookContext,
  HookLifecycle,
  HookOutcome,
} from "@/app/lib/hooks/types";

function ctx(over: Partial<HookContext> = {}): HookContext {
  return {
    lifecycle: "beforeSettle",
    owner: "0xowner",
    walletId: "0xwallet",
    chain: "bnb",
    token: "USDC",
    recipient: "0xrecipient",
    amount: "1.5",
    amountUsd: 1.5,
    source: "send",
    ...over,
  };
}

function hook(
  name: string,
  lifecycle: HookLifecycle,
  run: () => Promise<HookOutcome> | HookOutcome,
  opts: { failMode?: "open" | "closed"; shouldRun?: () => boolean | Promise<boolean> } = {},
): Hook {
  return {
    name,
    lifecycle,
    failMode: opts.failMode ?? "closed",
    shouldRun: opts.shouldRun ?? (() => true),
    run: async () => run(),
  };
}

const ALLOW: HookOutcome = { action: "allow" };
const DENY = (code: string): HookOutcome => ({
  action: "deny",
  code,
  reason: code,
  status: 403,
});

describe("hook dispatcher", () => {
  it("empty registry → allow, nothing ran", async () => {
    const r = await runHooks("beforeSettle", ctx(), []);
    expect(r.outcome).toEqual({ action: "allow" });
    expect(r.ran).toEqual([]);
  });

  it("single allow hook → allow, recorded in ran", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("a", "beforeSettle", () => ALLOW),
    ]);
    expect(r.outcome.action).toBe("allow");
    expect(r.ran).toEqual(["a"]);
  });

  it("shouldRun=false → hook skipped, not in ran", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("skip", "beforeSettle", () => DENY("SHOULD_NOT_FIRE"), {
        shouldRun: () => false,
      }),
    ]);
    expect(r.outcome.action).toBe("allow");
    expect(r.ran).toEqual([]);
  });

  it("first deny short-circuits — later hooks never run", async () => {
    let secondRan = false;
    const r = await runHooks("beforeSettle", ctx(), [
      hook("first", "beforeSettle", () => DENY("BLOCKED")),
      hook("second", "beforeSettle", () => {
        secondRan = true;
        return ALLOW;
      }),
    ]);
    expect(r.outcome).toMatchObject({ action: "deny", code: "BLOCKED" });
    expect(r.ran).toEqual(["first"]);
    expect(secondRan).toBe(false);
  });

  it("lifecycle filter — only matching-lifecycle hooks run", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("auth", "beforeAuthorize", () => DENY("WRONG_PHASE")),
      hook("settle", "beforeSettle", () => ALLOW),
    ]);
    expect(r.outcome.action).toBe("allow");
    expect(r.ran).toEqual(["settle"]);
  });

  it("split collected and returned when no deny follows", async () => {
    const split: HookOutcome = {
      action: "split",
      parts: [
        { recipient: "0xa", amount: "0.7" },
        { recipient: "0xb", amount: "0.3" },
      ],
    };
    const r = await runHooks("beforeSettle", ctx(), [
      hook("splitter", "beforeSettle", () => split),
    ]);
    expect(r.outcome).toEqual(split);
    expect(r.ran).toEqual(["splitter"]);
  });

  it("two splits → MULTIPLE_SPLITS deny", async () => {
    const s = (): HookOutcome => ({
      action: "split",
      parts: [{ recipient: "0xa", amount: "1.5" }],
    });
    const r = await runHooks("beforeSettle", ctx(), [
      hook("split1", "beforeSettle", s),
      hook("split2", "beforeSettle", s),
    ]);
    expect(r.outcome).toMatchObject({ action: "deny", code: "MULTIPLE_SPLITS" });
  });

  it("split outside beforeSettle → INVALID_SPLIT_LIFECYCLE deny", async () => {
    const r = await runHooks("beforeAuthorize", ctx({ lifecycle: "beforeAuthorize" }), [
      hook("badsplit", "beforeAuthorize", () => ({
        action: "split",
        parts: [{ recipient: "0xa", amount: "1.5" }],
      })),
    ]);
    expect(r.outcome).toMatchObject({
      action: "deny",
      code: "INVALID_SPLIT_LIFECYCLE",
    });
  });

  it("deny AFTER a split still wins (split is not a terminal allow)", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("splitter", "beforeSettle", () => ({
        action: "split",
        parts: [{ recipient: "0xa", amount: "1.5" }],
      })),
      hook("gate", "beforeSettle", () => DENY("REP_TOO_LOW")),
    ]);
    expect(r.outcome).toMatchObject({ action: "deny", code: "REP_TOO_LOW" });
  });

  it("hook throws + failMode=open → treated as allow, chain continues", async () => {
    let laterRan = false;
    const r = await runHooks("beforeSettle", ctx(), [
      hook(
        "flaky",
        "beforeSettle",
        () => {
          throw new Error("rpc timeout");
        },
        { failMode: "open" },
      ),
      hook("later", "beforeSettle", () => {
        laterRan = true;
        return ALLOW;
      }),
    ]);
    expect(r.outcome.action).toBe("allow");
    expect(laterRan).toBe(true);
    expect(r.ran).toEqual(["flaky", "later"]);
  });

  it("hook throws + failMode=closed → deny with {name}_ERROR + 502", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook(
        "compliance",
        "beforeSettle",
        () => {
          throw new Error("ofac list unavailable");
        },
        { failMode: "closed" },
      ),
    ]);
    expect(r.outcome).toMatchObject({
      action: "deny",
      code: "compliance_ERROR",
      status: 502,
    });
  });

  it("shouldRun throws + failMode=closed → deny", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("compliance", "beforeSettle", () => ALLOW, {
        failMode: "closed",
        shouldRun: () => {
          throw new Error("config read failed");
        },
      }),
    ]);
    expect(r.outcome).toMatchObject({
      action: "deny",
      code: "compliance_ERROR",
    });
  });

  it("shouldRun throws + failMode=open → hook skipped silently", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("filter", "beforeSettle", () => DENY("SHOULD_NOT_FIRE"), {
        failMode: "open",
        shouldRun: () => {
          throw new Error("config read failed");
        },
      }),
    ]);
    expect(r.outcome.action).toBe("allow");
    expect(r.ran).toEqual([]);
  });

  it("multiple allow hooks all run and record in order", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("one", "beforeSettle", () => ALLOW),
      hook("two", "beforeSettle", () => ALLOW),
      hook("three", "beforeSettle", () => ALLOW),
    ]);
    expect(r.outcome.action).toBe("allow");
    expect(r.ran).toEqual(["one", "two", "three"]);
  });

  // ── require_approval precedence (deny > require_approval > split > allow) ──
  const APPROVAL = (code: string): HookOutcome => ({
    action: "require_approval",
    code,
    reason: code,
    status: 202,
  });

  it("require_approval is returned when no deny follows", async () => {
    const r = await runHooks("beforeAuthorize", ctx({ lifecycle: "beforeAuthorize" }), [
      hook("cap", "beforeAuthorize", () => APPROVAL("OVER_CAP")),
    ]);
    expect(r.outcome).toMatchObject({ action: "require_approval", code: "OVER_CAP" });
  });

  it("a later DENY overrides an earlier require_approval", async () => {
    const r = await runHooks("beforeAuthorize", ctx({ lifecycle: "beforeAuthorize" }), [
      hook("cap", "beforeAuthorize", () => APPROVAL("OVER_CAP")),
      hook("compliance", "beforeAuthorize", () => DENY("BLOCKED")),
    ]);
    expect(r.outcome).toMatchObject({ action: "deny", code: "BLOCKED" });
  });

  it("require_approval keeps the FIRST one + continues the chain", async () => {
    let secondRan = false;
    const r = await runHooks("beforeAuthorize", ctx({ lifecycle: "beforeAuthorize" }), [
      hook("a", "beforeAuthorize", () => APPROVAL("FIRST")),
      hook("b", "beforeAuthorize", () => {
        secondRan = true;
        return APPROVAL("SECOND");
      }),
    ]);
    expect(r.outcome).toMatchObject({ action: "require_approval", code: "FIRST" });
    expect(secondRan).toBe(true);
  });

  it("require_approval OUTRANKS a split (don't settle until approved)", async () => {
    const r = await runHooks("beforeSettle", ctx(), [
      hook("splitter", "beforeSettle", () => ({
        action: "split",
        parts: [{ recipient: "0xa", amount: "1.5" }],
      })),
      hook("cap", "beforeSettle", () => APPROVAL("OVER_CAP")),
    ]);
    expect(r.outcome).toMatchObject({ action: "require_approval", code: "OVER_CAP" });
  });
});
