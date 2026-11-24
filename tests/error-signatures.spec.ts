import { describe, expect, it } from "vitest";
import {
  buildErrorCandidates,
  fixEligible,
  normalizeErrorSignature,
} from "../src/support/error-signatures.ts";
import type { NormalizerRecord } from "../src/support/tracker.ts";
import type { DoctorConfig } from "../src/types.ts";

function failedRecord(overrides: Partial<NormalizerRecord> = {}): NormalizerRecord {
  return {
    id: `rec_${Math.random().toString(36).slice(2)}`,
    time: Date.now(),
    toolName: "read",
    category: "PASSTHROUGH",
    wasHealed: false,
    originalArgsPreview: '{"file_path":"/a.txt"}',
    status: "failed",
    errorMessage: "ENOENT: no such file or directory",
    ...overrides,
  };
}

describe("normalizeErrorSignature", () => {
  it("collapses whitespace runs", () => {
    expect(normalizeErrorSignature("a   b\n\tc")).toBe("a b c");
  });

  it("masks string literals", () => {
    const sig = normalizeErrorSignature('cannot read "/very/long/path/file.txt"');
    expect(sig).toContain("<str>");
    expect(sig).not.toContain("/very/long/path");
  });

  it("masks Windows paths", () => {
    const sig = normalizeErrorSignature("failed at C:\\Users\\Srini\\Documents\\x.md line 12");
    expect(sig).toContain("<path>");
    expect(sig).not.toContain("C:\\Users");
  });

  it("masks numbers but keeps identifiers", () => {
    const sig = normalizeErrorSignature("offset 99 is out of range (40 lines) for file2");
    expect(sig).toContain("<n>");
    expect(sig).not.toContain("99");
    expect(sig).toContain("file2");
  });

  it("masks UUIDs and long hex ids", () => {
    const sig = normalizeErrorSignature(
      "job a3f1c9d2e4b567890abcdef failed; uuid 123e4567-e89b-12d3-a456-426614174000",
    );
    expect(sig).toContain("<id>");
    expect(sig).not.toContain("a3f1c9d2e4b567890abcdef");
  });

  it("clips very long signatures with an ellipsis", () => {
    const sig = normalizeErrorSignature(`x${"y".repeat(500)}`);
    expect(sig.length).toBeLessThanOrEqual(181);
    expect(sig.endsWith("…")).toBe(true);
  });
});

describe("buildErrorCandidates", () => {
  it("groups identical failures into one candidate with a count", () => {
    const records = [
      failedRecord({ errorMessage: "ENOENT: no such file or directory, open '/a'" }),
      failedRecord({ errorMessage: "ENOENT: no such file or directory, open '/b'" }),
    ];
    // Different paths → same signature after masking.
    const candidates = buildErrorCandidates(records);
    expect(candidates.length).toBe(1);
    expect(candidates[0].count).toBe(2);
  });

  it("marks a candidate attempted-failed when a heal was tried", () => {
    const records = [
      failedRecord({
        category: "RANGE_CLAMP",
        wasHealed: true,
        errorMessage: 'offset 9 is out of range for "/a" (5 lines)',
      }),
    ];
    const candidates = buildErrorCandidates(records);
    expect(candidates.length).toBe(1);
    expect(candidates[0].verdict).toBe("attempted-failed");
    expect(typeof candidates[0].ruleHint === "number").toBe(true);
  });

  it("marks a candidate possible-existing when a rule hint matches the text", () => {
    const records = [failedRecord({ errorMessage: "Unknown tool: bash" })];
    const candidates = buildErrorCandidates(records);
    expect(candidates[0].verdict).toBe("possible-existing");
  });

  it("marks a candidate new-rule-candidate when nothing matches", () => {
    const records = [failedRecord({ errorMessage: "totally novel failure mode zzz" })];
    const candidates = buildErrorCandidates(records);
    expect(candidates[0].verdict).toBe("new-rule-candidate");
  });

  it("ignores successful and passthrough-success records", () => {
    const records = [failedRecord({ status: "success", wasHealed: true })];
    expect(buildErrorCandidates(records)).toHaveLength(0);
  });

  it("sorts by count descending, then recency", () => {
    const now = Date.now();
    const records = [
      failedRecord({ id: "a", time: now - 1000, errorMessage: "error alpha" }),
      failedRecord({ id: "b", time: now - 500, errorMessage: "error beta" }),
      failedRecord({ id: "c", time: now - 400, errorMessage: "error beta" }),
    ];
    const candidates = buildErrorCandidates(records);
    expect(candidates[0].count).toBe(2);
    expect(candidates[0].key.startsWith("read")).toBe(true);
  });

  it("respects the limit", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const records = words.map((word, i) =>
      failedRecord({ id: `r${i}`, errorMessage: `distinct failure ${word} zzz` }),
    );
    expect(buildErrorCandidates(records, 3)).toHaveLength(3);
  });
});

describe("fix proposals", () => {
  const CONFIG: DoctorConfig = {
    autoWrapRunCode: true,
    autoBridgeDirectTools: true,
    autoObserveFiles: true,
    autoClampRanges: true,
    injectPrompt: false,
    errorHints: true,
    persistPassthrough: false,
    healResponseTools: true,
    autoSchemaArgs: true,
    autoFuzzyEdit: true,
    autoNormalizePaths: true,
    autoKindFixes: true,
  autoSubagentRouteFixes: false,
    shadowMode: false,
  };
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Three failures of one signature, spanning more than the eligibility window. */
  function recurring(toolFailure: string): NormalizerRecord[] {
    const base = Date.now() - DAY_MS;
    return [
      failedRecord({ time: base, errorMessage: toolFailure }),
      failedRecord({ time: base + 6 * 60 * 1000, errorMessage: toolFailure }),
      failedRecord({ time: base + 20 * 60 * 1000, errorMessage: toolFailure }),
    ];
  }

  it("fixEligible needs both recurrence AND elapsed span", () => {
    const t0 = Date.now();
    expect(fixEligible(3, t0, t0 + 11 * 60 * 1000)).toBe(true);
    // Three in a burst: enough counts, not enough time.
    expect(fixEligible(3, t0, t0 + 60_000)).toBe(false);
    // One over a day: enough time, not enough counts.
    expect(fixEligible(2, t0, t0 + DAY_MS)).toBe(false);
  });

  it("withholds the fix (fixable=false, no proposedFix) until eligible", () => {
    const recent = [
      failedRecord({ errorMessage: "Unknown tool: bash" }),
      failedRecord({ errorMessage: "Unknown tool: bash" }),
    ];
    const [candidate] = buildErrorCandidates(recent, 60, CONFIG);
    expect(candidate.fixable).toBe(false);
    expect(candidate.proposedFix).toBeUndefined();
  });

  it("offers enable-flag when the owning rule is switched off", () => {
    const [candidate] = buildErrorCandidates(
      recurring("Unknown tool: mytool"),
      60,
      { ...CONFIG, autoBridgeDirectTools: false },
    );
    expect(candidate.fixable).toBe(true);
    expect(candidate.proposedFix).toEqual({
      kind: "enable-flag",
      flag: "autoBridgeDirectTools",
      rule: 2,
    });
  });

  it("reports a gate-gap when the owning rule is already on", () => {
    const [candidate] = buildErrorCandidates(recurring("Unknown tool: mytool"), 60, CONFIG);
    expect(candidate.proposedFix?.kind).toBe("gate-gap");
    expect(candidate.proposedFix?.rule).toBe(2);
  });

  it("proposes refining the rule that attempted and still failed", () => {
    const base = Date.now() - DAY_MS;
    const [candidate] = buildErrorCandidates(
      [
        failedRecord({ time: base, category: "RANGE_CLAMP", wasHealed: true, errorMessage: "offset 9 out of range v1" }),
        failedRecord({ time: base + 11 * 60 * 1000, category: "RANGE_CLAMP", wasHealed: true, errorMessage: "offset 9 out of range v1" }),
        failedRecord({ time: base + 15 * 60 * 1000, category: "RANGE_CLAMP", wasHealed: true, errorMessage: "offset 9 out of range v1" }),
      ],
      60,
      CONFIG,
    );
    expect(candidate.fixable).toBe(true);
    expect(candidate.proposedFix).toMatchObject({ kind: "refine-rule" });
  });

  it("flags an uncovered pattern as a new-rule candidate to author", () => {
    const [candidate] = buildErrorCandidates(
      recurring("totally novel failure mode zzz"),
      60,
      CONFIG,
    );
    expect(candidate.fixable).toBe(true);
    expect(candidate.proposedFix).toEqual({ kind: "new-rule" });
  });

  it("resolves without a config (no flag assertion possible)", () => {
    const [candidate] = buildErrorCandidates(recurring("Unknown tool: mytool"));
    expect(candidate.fixable).toBe(true);
    // No config → cannot prove a toggle is off, so it stays a gate-gap.
    expect(candidate.proposedFix?.kind).toBe("gate-gap");
  });
});
