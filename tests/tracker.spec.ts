/**
 * Tracker semantics for the dashboard's honest numbers:
 * - shadow matches never inflate healed success/failure or token savings;
 * - recurring-error signature aggregates count EVERY failure, independent
 *   of the bounded dashboard record ring;
 * - restore rebuilds signatures from the full replay stream;
 * - the record-window grouping and the durable aggregates judge identically
 *   (candidatesFromAggregates is the single verdict path).
 */
import { describe, expect, it } from "vitest";

import {
  ToolNormalizerTracker,
  type NormalizerRecord,
  type NormalizerStats,
} from "../src/support/tracker.ts";
import {
  buildErrorCandidates,
  candidatesFromAggregates,
} from "../src/support/error-signatures.ts";

let seq = 0;

function record(overrides: Partial<NormalizerRecord> = {}): NormalizerRecord {
  seq += 1;
  return {
    id: `rec_${seq}`,
    time: 1_700_000_000_000 + seq * 1000,
    toolName: "edit",
    category: "PASSTHROUGH",
    wasHealed: false,
    originalArgsPreview: "{}",
    status: "success",
    ...overrides,
  };
}

describe("tracker — shadow matches are counted honestly", () => {
  it("a shadow success counts as a match + pass-through, never as a heal or saving", () => {
    const t = new ToolNormalizerTracker();
    t.record(
      record({
        wasHealed: true,
        category: "ARGS_TYPE",
        status: "success",
        shadow: true,
        tokensSaved: 500,
      }),
    );
    const s = t.getSnapshot();
    expect(s.shadowMatches).toBe(1);
    expect(s.passThrough).toBe(1);
    expect(s.healedSuccess).toBe(0);
    expect(s.estimatedTokensSaved).toBe(0); // the original went out unchanged
    expect(s.healingSuccessRate).toBe(0); // rate ignores shadow entirely
    expect(s.byCategory["ARGS_TYPE"]).toBe(1); // coverage still visible
  });

  it("a shadow failure lands in passThroughFailed and the failure ranks", () => {
    const t = new ToolNormalizerTracker();
    t.record(
      record({
        wasHealed: true,
        category: "ARGS_TYPE",
        status: "failed",
        shadow: true,
        errorMessage: "old_string not found",
      }),
    );
    const s = t.getSnapshot();
    expect(s.shadowMatches).toBe(1);
    expect(s.passThroughFailed).toBe(1);
    expect(s.healedFailed).toBe(0);
    expect(s.failuresByTool["edit"]).toBe(1);
  });

  it("non-shadow records are unaffected by the new bucket", () => {
    const t = new ToolNormalizerTracker();
    t.record(record({ wasHealed: true, category: "ARGS_TYPE", status: "success", tokensSaved: 120 }));
    t.record(record({ status: "failed", errorMessage: "boom" }));
    const s = t.getSnapshot();
    expect(s.shadowMatches).toBe(0);
    expect(s.healedSuccess).toBe(1);
    expect(s.estimatedTokensSaved).toBe(120);
    expect(s.passThroughFailed).toBe(1);
  });

  it("shadowMatches survives reset and restore", () => {
    const t = new ToolNormalizerTracker();
    t.record(record({ wasHealed: true, status: "success", shadow: true }));
    expect(t.getSnapshot().shadowMatches).toBe(1);
    t.reset();
    expect(t.getSnapshot().shadowMatches).toBe(0);
    expect(t.getSignatureAggregates()).toEqual([]);
  });
});

describe("tracker — signature aggregates outlive the record ring", () => {
  it("counts every failure even after the ring window evicts records", () => {
    const t = new ToolNormalizerTracker();
    for (let i = 0; i < 1002; i++) {
      seq += 1;
      t.record({
        id: `ev_${i}`,
        time: 1_700_000_000_000 + i,
        toolName: "read",
        category: "PASSTHROUGH",
        wasHealed: false,
        originalArgsPreview: "{}",
        status: "failed",
        errorMessage: "ENOENT: no such file or directory, open '/x.txt'",
      });
    }
    const s = t.getSnapshot();
    expect(s.recentRecords.length).toBe(1000); // ring stays bounded
    const aggs = t.getSignatureAggregates();
    expect(aggs.length).toBe(1);
    expect(aggs[0]!.count).toBe(1002); // the count does not
  });

  it("bounds the aggregate map by evicting the least-recently-seen pattern", () => {
    const t = new ToolNormalizerTracker();
    // 210 distinct patterns (distinct even after signature normalization:
    // digits are masked, so identity rides on distinct letter suffixes);
    // cap is 200. Times are strictly increasing.
    const times: number[] = [];
    const letters = (i: number): string => {
      let s = "";
      let n = i;
      do {
        s = String.fromCharCode(97 + (n % 26)) + s;
        n = Math.floor(n / 26);
      } while (n > 0);
      return s;
    };
    for (let i = 0; i < 210; i++) {
      const r = record({ status: "failed", toolName: "exec", errorMessage: `fail case ${letters(i)}` });
      times.push(r.time);
      t.record(r);
    }
    const aggs = t.getSignatureAggregates();
    expect(aggs.length).toBe(200);
    // The ten least-recently-seen patterns were evicted; the newest remains.
    const lastSeens = aggs.map((a) => a.lastSeen).sort((a, b) => a - b);
    expect(lastSeens[0]).toBe(times[10]);
    expect(lastSeens[199]).toBe(times[209]);
  });

  it("restore rebuilds signatures from the full replay, not the ring window", () => {
    const t = new ToolNormalizerTracker();
    const all: NormalizerRecord[] = [];
    for (let i = 0; i < 1500; i++) {
      all.push(
        record({
          status: "failed",
          toolName: "bash",
          errorMessage: "exit code 1",
          time: 1_700_000_000_000 + i,
        }),
      );
    }
    const stats: NormalizerStats = {
      totalIntercepted: 1500,
      healedSuccess: 0,
      healedFailed: 0,
      promoted: 0,
      passThrough: 0,
      passThroughFailed: 1500,
      shadowMatches: 0,
      estimatedTokensSaved: 0,
      healingSuccessRate: 0,
      byTool: { bash: 1500 },
      byCategory: { PASSTHROUGH: 1500 },
      failuresByTool: { bash: 1500 },
      failuresByCategory: { PASSTHROUGH: 1500 },
      recentRecords: all.slice(500), // ring window from the replay
    };
    t.restore(stats, all); // full stream passed
    const aggs = t.getSignatureAggregates();
    expect(aggs.length).toBe(1);
    expect(aggs[0]!.count).toBe(1500);
    expect(aggs[0]!.firstSeen).toBe(all[0]!.time);
  });

  it("record-window grouping and durable aggregates reach identical candidates", () => {
    // Same failures fed two ways: through the tracker (incremental) and
    // through the record-window grouping. Both judge via one path, so the
    // candidate lists must be deep-equal.
    const mixed: NormalizerRecord[] = [
      record({ status: "failed", toolName: "edit", errorMessage: "old_string not found in file", category: "INVALID_ARGS", wasHealed: true }),
      record({ status: "failed", toolName: "edit", errorMessage: "old_string not found in file", category: "INVALID_ARGS", wasHealed: true }),
      record({ status: "failed", toolName: "edit", errorMessage: "old_string not found in file", category: "PASSTHROUGH" }),
      record({ status: "failed", toolName: "read", errorMessage: "ENOENT: /a.txt" }),
      record({ status: "success", toolName: "read" }), // never grouped
    ];
    const t = new ToolNormalizerTracker();
    for (const r of mixed) t.record(r);
    const viaAggregates = candidatesFromAggregates(t.getSignatureAggregates());
    const viaWindow = buildErrorCandidates(mixed);
    expect(viaAggregates).toEqual(viaWindow);
    // The healed-category pattern is judged attempted-failed with fix gating.
    expect(viaAggregates[0]!.verdict).toBe("attempted-failed");
    expect(viaAggregates[0]!.count).toBe(3);
  });

  it("shadow failures still aggregate — a real failure is a real failure", () => {
    const t = new ToolNormalizerTracker();
    t.record(
      record({
        status: "failed",
        toolName: "edit",
        errorMessage: "old_string not found",
        wasHealed: true,
        category: "ARGS_TYPE",
        shadow: true,
      }),
    );
    const aggs = t.getSignatureAggregates();
    expect(aggs.length).toBe(1);
    expect(aggs[0]!.count).toBe(1);
    expect(aggs[0]!.healedCategories).toEqual(["ARGS_TYPE"]);
  });
});
