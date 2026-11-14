import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, CATEGORY_META, CATEGORY_TO_FLAG, POST_STAGES, PRE_STAGES, STAGES } from "../src/stages/index.ts";
import { TOGGLE_KEYS } from "../src/support/config-overrides.ts";
import type { HealCategory } from "../src/types.ts";

describe("stage registry", () => {
  it("registers sixteen stages in execution order (nine pre, seven post)", () => {
    expect(STAGES).toHaveLength(16);
    expect(PRE_STAGES).toHaveLength(9);
    expect(POST_STAGES).toHaveLength(7);
    // Pre-stages come first in the registry.
    for (let i = 0; i < PRE_STAGES.length; i++) {
      expect(STAGES[i]).toBe(PRE_STAGES[i]);
    }
  });

  it("gives every stage a unique id and label", () => {
    const ids = STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const stage of STAGES) {
      expect(stage.label.length).toBeGreaterThan(0);
    }
  });

  it("pins the category metadata table (labels, rules, round-trips)", () => {
    const meta = CATEGORY_META;
    // Every heal category has a human label.
    for (const label of Object.values(CATEGORY_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }

    // Rule numbers match the manual's rule inventory.
    expect(meta["INVALID_ARGS"]?.ruleNumber).toBe(1);
    expect(meta["CODE_WRAP"]?.ruleNumber).toBe(1);
    expect(meta["RUN_CODE_DESC"]?.ruleNumber).toBe(1);
    expect(meta["RUN_CODE_SYNTAX"]?.ruleNumber).toBe(1);
    expect(meta["INNER_DESC"]?.ruleNumber).toBe(1);
    expect(meta["MNEMON_RESULT"]?.ruleNumber).toBe(1);
    expect(meta["UNKNOWN_TOOL"]?.ruleNumber).toBe(2);
    expect(meta["RANGE_CLAMP"]?.ruleNumber).toBe(3);
    expect(meta["PATH_SCOPE"]?.ruleNumber).toBe(3);
    expect(meta["PATH_QUOTES"]?.ruleNumber).toBe(3);
    expect(meta["READ_ARGS"]?.ruleNumber).toBe(1);
    expect(meta["FS_OBSERVED"]?.ruleNumber).toBe(4);
    expect(meta["RESPONSE_TOOL_HEAL"]?.ruleNumber).toBe(7);
    expect(meta["ARGS_UNWRAP"]?.ruleNumber).toBe(9);
    expect(meta["ARGS_TYPE"]?.ruleNumber).toBe(9);
    expect(meta["PATH_SEPARATORS"]?.ruleNumber).toBe(3);
    expect(meta["EDIT_WHITESPACE"]?.ruleNumber).toBe(4);

    // Round-trip savings: a pre-dispatch repair saves one round trip; the
    // observe-retry family costs an extra read, so it is worth two.
    expect(meta["INVALID_ARGS"]?.roundTrips).toBe(1);
    expect(meta["UNKNOWN_TOOL"]?.roundTrips).toBe(1);
    expect(meta["FS_OBSERVED"]?.roundTrips).toBe(2);
    expect(meta["EDIT_WHITESPACE"]?.roundTrips).toBe(2);

    // Every category carries a matchesError predicate except the pure labels.
    for (const category of [
      "INVALID_ARGS",
      "CODE_WRAP",
      "RUN_CODE_DESC",
      "RUN_CODE_SYNTAX",
      "UNKNOWN_TOOL",
      "RANGE_CLAMP",
      "PATH_SCOPE",
      "PATH_QUOTES",
      "READ_ARGS",
      "ARGS_UNWRAP",
      "ARGS_TYPE",
      "PATH_SEPARATORS",
      "EDIT_WHITESPACE",
    ] as HealCategory[]) {
      expect(typeof meta[category]?.matchesError).toBe("function");
    }
  });

  it("derives CATEGORY_LABELS from the metadata keys (no drift)", () => {
    const labelKeys = Object.keys(CATEGORY_LABELS);
    const metaKeys = Object.keys(CATEGORY_META);
    expect(labelKeys.sort()).toEqual([...metaKeys].sort());
  });

  it("keeps post-stage terminal/claimsHeal flags explicit", () => {
    const bridge = POST_STAGES.find((s) => s.id === "bridge");
    expect(bridge?.terminal).toBe(true);
    const anchor = POST_STAGES.find((s) => s.id === "anchor-refresh");
    expect(anchor?.claimsHeal).toBe(false); // side-effect only, never claims a heal
  });

  it("every stage with a static category resolves its metadata", () => {
    for (const stage of STAGES) {
      if (stage.category !== undefined) {
        expect(CATEGORY_META[stage.category]).toBeDefined();
      }
    }
  });

  it("every stage names a real config flag as its gate", () => {
    for (const stage of STAGES) {
      expect(stage.enabledBy, `stage ${stage.id}`).toBeTruthy();
      expect(TOGGLE_KEYS).toContain(stage.enabledBy);
    }
  });

  it("CATEGORY_TO_FLAG covers every rule-owning category", () => {
    for (const [category, meta] of Object.entries(CATEGORY_META)) {
      if (meta.ruleNumber !== undefined) {
        expect(CATEGORY_TO_FLAG[category as HealCategory], category).toBeTruthy();
      }
    }
    // Spot-check the family mapping the fix proposals rely on.
    expect(CATEGORY_TO_FLAG["READ_ARGS"]).toBe("autoClampRanges");
    expect(CATEGORY_TO_FLAG["UNKNOWN_TOOL"]).toBe("autoBridgeDirectTools");
    expect(CATEGORY_TO_FLAG["ARGS_TYPE"]).toBe("autoSchemaArgs");
    expect(CATEGORY_TO_FLAG["PATH_SEPARATORS"]).toBe("autoNormalizePaths");
    expect(CATEGORY_TO_FLAG["EDIT_WHITESPACE"]).toBe("autoFuzzyEdit");
  });
});
