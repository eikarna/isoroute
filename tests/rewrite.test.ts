import { describe, expect, it } from "bun:test";
import { RewriteEngine, type RouteRule } from "../src/core/rewrite";

describe("RewriteEngine Force Routing", () => {
  const rules: RouteRule[] = [
    { id: "r1", pattern: "claude-*-opus", target: "gemini-$1-latest", priority: 100, enabled: true },
    { id: "r2", pattern: "claude*sonnet", target: "free-fast", priority: 90, enabled: true },
    { id: "r3", pattern: "*high*", target: "gemini-3.8-flash-high", priority: 80, enabled: true },
    { id: "r4", pattern: "*high", target: "deepseek-v4.1-flash", priority: 70, enabled: true },
    { id: "r5", pattern: "claude*", target: "gemini*", priority: 50, enabled: true },
    { id: "r6", pattern: "disabled-pattern", target: "should-not-match", priority: 999, enabled: false },
  ];

  it("rewrites wildcard with capture replacement ($1)", () => {
    const res = RewriteEngine.rewrite("claude-3-5-opus", rules);
    expect(res.matched).toBe(true);
    expect(res.targetModel).toBe("gemini-3-5-latest");
    expect(res.ruleId).toBe("r1");
  });

  it("rewrites wildcards with asterisks in target (claude* -> gemini*)", () => {
    const res = RewriteEngine.rewrite("claude-haiku", rules);
    expect(res.matched).toBe(true);
    expect(res.targetModel).toBe("gemini-haiku");
    expect(res.ruleId).toBe("r5");
  });

  it("rewrites claude*sonnet to static combo", () => {
    const res = RewriteEngine.rewrite("claude-3.7-sonnet", rules);
    expect(res.matched).toBe(true);
    expect(res.targetModel).toBe("free-fast");
    expect(res.ruleId).toBe("r2");
  });

  it("respects priority ordering (*high* vs *high)", () => {
    // Both r3 (*high*) and r4 (*high) could match "ultra-high", but r3 has higher priority (80 > 70)
    const res = RewriteEngine.rewrite("ultra-high", rules);
    expect(res.matched).toBe(true);
    expect(res.targetModel).toBe("gemini-3.8-flash-high");
    expect(res.ruleId).toBe("r3");
  });

  it("ignores disabled rules", () => {
    const res = RewriteEngine.rewrite("disabled-pattern", rules);
    expect(res.matched).toBe(false);
    expect(res.targetModel).toBe("disabled-pattern");
  });

  it("returns original model unchanged when no rule matches", () => {
    const res = RewriteEngine.rewrite("qwen-2.5-coder", rules);
    expect(res.matched).toBe(false);
    expect(res.targetModel).toBe("qwen-2.5-coder");
  });

  it("is resilient to ReDoS attack strings in pattern", () => {
    const evilPattern = "((((((a+)+)+)+)+)+)*";
    const start = Date.now();
    const regex = RewriteEngine.compilePattern(evilPattern);
    const matched = regex.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaab");
    const duration = Date.now() - start;
    expect(matched).toBe(false);
    expect(duration).toBeLessThan(50); // Under 50ms, zero catastrophic backtracking
  });
});
