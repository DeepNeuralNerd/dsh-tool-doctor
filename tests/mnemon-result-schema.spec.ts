import { describe, expect, it } from "vitest";
import { repairMnemonResultArgs } from "../src/repair/mnemon-result-schema.ts";

function resultOf(out: ReturnType<typeof repairMnemonResultArgs>): Record<string, unknown> {
  if (out === undefined) throw new Error("expected a repair");
  return out.args.result as Record<string, unknown>;
}

describe("repairMnemonResultArgs", () => {
  it("fills suggestions[n].steps from the suggestion's own text", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: { suggestions: [{ text: "do the thing" }] },
    });
    expect(out).toBeDefined();
    const steps = (resultOf(out)!.suggestions as Array<Record<string, unknown>>)[0].steps;
    expect(steps).toEqual(["do the thing"]);
  });

  it("wraps a bare-string steps in an array", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: { suggestions: [{ steps: "single step" }] },
    });
    expect(out).toBeDefined();
    const steps = (resultOf(out)!.suggestions as Array<Record<string, unknown>>)[0].steps;
    expect(steps).toEqual(["single step"]);
  });

  it("fills a missing answer from the result's own steps", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: { steps: ["step one", "step two"] },
    });
    expect(out).toBeDefined();
    expect(resultOf(out)!.answer).toBe("step one\nstep two");
  });

  it("falls back to summary when there are no steps", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: { suggestions: [], summary: "all done" },
    });
    expect(out).toBeDefined();
    expect(resultOf(out)!.answer).toBe("all done");
  });

  it("never invents content: no steps and no summary leaves the result alone", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: {},
    });
    expect(out).toBeUndefined();
  });

  it("returns undefined for other tools", () => {
    expect(repairMnemonResultArgs("read", {})).toBeUndefined();
  });

  it("records what it changed in the change labels", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: { suggestions: [{ text: "x" }] },
    });
    expect(out).toBeDefined();
    if (out !== undefined) {
      expect(out.changes.length).toBeGreaterThan(0);
      expect(out.changes.join("; ")).toContain("suggestions[0].steps");
    }
  });

  it("keeps an existing answer untouched", () => {
    const out = repairMnemonResultArgs("mnemon_subagent_result", {
      requestId: "r1",
      result: { answer: "already there", summary: "ignored" },
    });
    expect(out).toBeUndefined(); // nothing to repair
  });
});
