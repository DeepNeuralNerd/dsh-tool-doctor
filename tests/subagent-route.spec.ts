/**
 * Tests for repairSubagentRouteArgs (SUBAGENT_ROUTE rule).
 *
 * @module dsh-tool-doctor/tests/subagent-route
 */

import { describe, expect, it } from "vitest";
import { repairSubagentRouteArgs } from "../src/repair/subagent-route.ts";

const PROVIDERS = ["lmstudio", "deepseek", "openrouter"];
const MODELS: Record<string, readonly string[]> = {
  lmstudio: ["minimax-h3-m2.5-v4-pro-1.2", "qwen3.8-next-nvfp4"],
  deepseek: ["deepseek-v4-pro"],
};

describe("repairSubagentRouteArgs", () => {
  it("canonicalizes provider casing when exactly one provider matches", () => {
    const out = repairSubagentRouteArgs("subagent", { provider: "LMStudio", prompt: "p" }, PROVIDERS, MODELS);
    expect(out?.args.provider).toBe("lmstudio");
    expect(out?.changes).toEqual(["Canonicalized provider casing to the host's spelling"]);
  });

  it("canonicalizes model casing under the resolved provider", () => {
    const out = repairSubagentRouteArgs(
      "subagent",
      { provider: "LMStudio", model: "MiniMax-H3-M2.5-V4-Pro-1.2" },
      PROVIDERS,
      MODELS,
    );
    expect(out?.args.provider).toBe("lmstudio");
    expect(out?.args.model).toBe("minimax-h3-m2.5-v4-pro-1.2");
    expect(out?.changes).toHaveLength(2);
  });

  it("leaves an exact-spelling route untouched", () => {
    expect(
      repairSubagentRouteArgs("subagent", { provider: "lmstudio", model: "qwen3.8-next-nvfp4" }, PROVIDERS, MODELS),
    ).toBeUndefined();
  });

  it("abstains when no provider matches case-insensitively", () => {
    expect(repairSubagentRouteArgs("subagent", { provider: "Nebula" }, PROVIDERS, MODELS)).toBeUndefined();
  });

  it("abstains when multiple providers differ only by case", () => {
    expect(
      repairSubagentRouteArgs("subagent", { provider: "LMStudio" }, ["lmstudio", "LMStudio"], MODELS),
    ).toBeUndefined();
  });

  it("never rewrites an unknown provider value", () => {
    // The emitted provider matches nothing: the host error stays honest.
    expect(
      repairSubagentRouteArgs("subagent", { provider: "Ollama", model: "anything" }, PROVIDERS, MODELS),
    ).toBeUndefined();
  });

  it("skips model canonicalization when the provider has no model list", () => {
    const out = repairSubagentRouteArgs("subagent", { provider: "OpenRouter", model: "X" }, PROVIDERS, MODELS);
    expect(out?.changes).toEqual(["Canonicalized provider casing to the host's spelling"]);
    expect(out?.args.model).toBe("X");
  });

  it("only touches subagent calls", () => {
    expect(repairSubagentRouteArgs("subagent_fork", { provider: "LMStudio" }, PROVIDERS, MODELS)).toBeUndefined();
  });

  it("leaves non-object and provider-less arguments untouched", () => {
    expect(repairSubagentRouteArgs("subagent", "prompt only", PROVIDERS, MODELS)).toBeUndefined();
    expect(repairSubagentRouteArgs("subagent", { prompt: "no provider" }, PROVIDERS, MODELS)).toBeUndefined();
  });

  it("is inert without a provider enumeration", () => {
    expect(repairSubagentRouteArgs("subagent", { provider: "LMStudio" }, undefined, undefined)).toBeUndefined();
  });

  it("never mutates the caller's arguments object", () => {
    const args = { provider: "LMStudio", prompt: "p" };
    repairSubagentRouteArgs("subagent", args, PROVIDERS, MODELS);
    expect(args.provider).toBe("LMStudio");
  });
});
