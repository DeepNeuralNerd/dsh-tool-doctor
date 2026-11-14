/**
 * Component-level tests (rendered React, not mirrored harness markup):
 * the reviewer's round-6 cases — trend data semantics, single-timestamp
 * rendering, and candidate aria wiring — must be exercised through the
 * components themselves.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  candidateDomId,
  derivePanelState,
  DoctorSection,
  eventAge,
  OutcomeTrend,
  trendDirection,
} from "../src/client/DoctorSection.tsx";
import {
  createEmptyStats,
  type DoctorCandidate,
  type DoctorState,
  type NormalizerRecord,
} from "../src/client/store.ts";

/** Identity translator: aria-labels then carry the locale KEYS as literals. */
const t = (key: string): string => key;

function record(over: Partial<NormalizerRecord> & { id: string; time: number }): NormalizerRecord {
  return {
    toolName: "edit",
    category: "INVALID_ARGS",
    wasHealed: false,
    originalArgsPreview: "{}",
    status: "failed",
    ...over,
  };
}

function state(over: Partial<DoctorState>): DoctorState {
  return {
    status: "ready",
    stats: createEmptyStats(),
    activeTab: "live",
    searchQuery: "",
    statusFilter: "all",
    config: null,
    candidates: null,
    polling: false,
    guidance: { text: null, defaultText: null },
    guidanceLoading: false,
    error: null,
    lastUpdated: null,
    statsStale: false,
    ...over,
  };
}

/** Effects never run under renderToStaticMarkup; only getSnapshot is read. */
function renderSection(seed: DoctorState): string {
  const controller = { getSnapshot: () => seed };
  return renderToStaticMarkup(
    <DoctorSection controller={controller as never} t={t as never} />,
  );
}

function firstAriaLabel(html: string): string {
  return /aria-label="([^"]*)"/.exec(html)?.[1] ?? "";
}

describe("OutcomeTrend (rendered)", () => {
  it("counts a shadow-mode failure as a failure, never as a repair", () => {
    const html = renderToStaticMarkup(
      <OutcomeTrend
        t={t}
        records={[
          record({ id: "r1", time: 1000, wasHealed: true, status: "success" }), // real repair
          record({ id: "r2", time: 2000, wasHealed: true, status: "failed", shadow: true }), // dispatched original failed
          record({ id: "r3", time: 3000, wasHealed: true, status: "success", shadow: true }), // never dispatched as a repair
        ]}
      />,
    );
    const label = firstAriaLabel(html);
    expect(label).toContain("1 trendRepaired");
    expect(label).toContain("1 trendFailed");
  });

  it("plots a lone event instead of an empty trend", () => {
    const html = renderToStaticMarkup(
      <OutcomeTrend t={t} records={[record({ id: "solo", time: 5000, status: "failed" })]} />,
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("trendEmpty");
    const label = firstAriaLabel(html);
    expect(label).toContain("0 trendRepaired");
    expect(label).toContain("1 trendFailed");
  });

  it("puts events sharing one timestamp into one bucket", () => {
    const html = renderToStaticMarkup(
      <OutcomeTrend
        t={t}
        records={[
          record({ id: "a", time: 7000, wasHealed: true, status: "success" }),
          record({ id: "b", time: 7000, status: "failed" }),
        ]}
      />,
    );
    expect(html).toContain("<svg");
    // Both events share one bucket → exactly two rects at the SAME x,
    // stacked without overlap, the lower one sitting on the baseline (H=48).
    const rects = [...html.matchAll(/<rect\b[^>]*?x="([\d.]+)"[^>]*?y="([\d.]+)"[^>]*?height="([\d.]+)"/g)].map(
      (m) => ({ x: Number(m[1]), y: Number(m[2]), h: Number(m[3]) }),
    );
    expect(rects.length).toBe(2);
    const [p, q] = rects as [{ x: number; y: number; h: number }, { x: number; y: number; h: number }];
    expect(q.x).toBe(p.x);
    const [lo, hi] = p.y > q.y ? [q, p] : [p, q];
    expect(lo.y + lo.h).toBeCloseTo(hi.y);
    expect(hi.y + hi.h).toBeCloseTo(48);
  });
});

describe("candidate aria wiring", () => {
  const candidate: DoctorCandidate = {
    key: 'edit ENOENT: no such file or directory, open "my notes.txt"',
    toolName: "edit",
    signature: 'ENOENT: no such file or directory, open "my notes.txt"',
    count: 7,
    firstSeen: 1,
    lastSeen: 2,
    verdict: "new-rule-candidate",
    fixable: false,
    categories: ["INVALID_ARGS"],
    sample: { errorMessage: "ENOENT", originalArgsPreview: "{}" },
  };

  it("candidateDomId is deterministic and free of whitespace", () => {
    const id = candidateDomId(candidate.key);
    expect(id).toBe(candidateDomId(candidate.key));
    expect(/\s/.test(id)).toBe(false);
    expect(id.startsWith("doctor-cand-")).toBe(true);
  });

  it("renders aria-controls as a single id token on the candidate button", () => {
    const html = renderSection(state({ activeTab: "errors", candidates: [candidate] }));
    const controls = /aria-controls="([^"]*)"/.exec(html)?.[1];
    expect(controls).toBeDefined();
    expect(/\s/.test(controls ?? " ")).toBe(false);
    expect(controls).toBe(candidateDomId(candidate.key));
  });
});

// ── Design pass: plain-language status, freshness, trend promise, settings ──

describe("panel status", () => {
  it("derives the honest order: paused > attention > ok > waiting", () => {
    expect(derivePanelState(createEmptyStats())).toBe("waiting");
    expect(derivePanelState({ ...createEmptyStats(), totalIntercepted: 5 })).toBe("ok");
    expect(
      derivePanelState({ ...createEmptyStats(), totalIntercepted: 5, passThroughFailed: 1 }),
    ).toBe("attention");
    expect(
      derivePanelState({ ...createEmptyStats(), passThroughFailed: 2, breakerOpen: ["RANGE_CLAMP"] }),
    ).toBe("paused");
  });

  it("leads the outcome card with the state, reason and action — evidence stays", () => {
    const html = renderSection(
      state({
        stats: {
          ...createEmptyStats(),
          totalIntercepted: 10,
          healedSuccess: 8,
          healedFailed: 1,
          passThroughFailed: 1,
        },
      }),
    );
    expect(html).toContain('data-state="attention"');
    expect(html).toContain("Needs attention"); // plain-language headline
    expect(html).toContain("See failing calls"); // one relevant action
    expect(html).toContain("calls that failed"); // the ONE user-language split
    expect(html).toContain("2 calls failed and were not repaired"); // lifetime, honestly labeled
    expect(html).not.toContain("failed repairs"); // jargon breakdown left the main view
    expect(html).not.toContain("unrecovered failures");
    expect(html).toContain(">8<"); // repaired count kept as evidence
  });

  it("shows a paused headline and routes to the rules", () => {
    const html = renderSection(
      state({
        stats: { ...createEmptyStats(), totalIntercepted: 4, breakerOpen: ["RANGE_CLAMP"] },
      }),
    );
    expect(html).toContain('data-state="paused"');
    expect(html).toContain("Repairs temporarily paused");
    expect(html).toContain("Review paused repairs");
  });
});

describe("snapshot freshness", () => {
  it("buckets age so the wording never jitters", () => {
    const now = 10_000_000_000;
    expect(eventAge(now, now - 30_000)).toEqual({ key: "updatedJustNow", n: 0 });
    expect(eventAge(now, now - 5 * 60_000)).toEqual({ key: "updatedMinutes", n: 5 });
    expect(eventAge(now, now - 130 * 60_000)).toEqual({ key: "updatedHours", n: 2 });
    expect(eventAge(now, now - 50 * 3_600_000)).toEqual({ key: "updatedDays", n: 2 });
    expect(eventAge(now, now + 10_000).key).toBe("updatedJustNow"); // clock skew clamps
  });

  it("shows the age while data is on screen", () => {
    const html = renderSection(
      state({
        stats: { ...createEmptyStats(), totalIntercepted: 3 },
        lastUpdated: Date.now() - 5 * 60_000,
      }),
    );
    expect(html).toContain("Updated 5 min ago");
    expect(html).not.toContain("Connection lost");
  });

  it("never claims health from a snapshot it could not refresh", () => {
    const html = renderSection(
      state({
        stats: { ...createEmptyStats(), totalIntercepted: 3, healedSuccess: 3 },
        lastUpdated: Date.now() - 60_000,
        statsStale: true,
        // The transient error slot is empty — freshness rides its own flag,
        // so a later config/guidance success cannot erase the stale claim.
        error: null,
      }),
    );
    // Headline: the honest stale claim, not the last-known healthy one…
    expect(html).toContain('data-state="stale"');
    expect(html).toContain("Showing saved data");
    expect(html).not.toContain("Working normally");
    // …with the meta line and the retained numbers kept below it.
    expect(html).toContain("Connection lost — showing saved data.");
    expect(html).toContain(">3<"); // repaired count still shown as saved evidence
  });

  it("shows no age before the first load", () => {
    const html = renderSection(
      state({ stats: { ...createEmptyStats(), totalIntercepted: 3 } }),
    );
    expect(html).not.toContain("Updated");
  });
});

describe("trend promise", () => {
  it("claims a direction only with four+ failures across a real span", () => {
    expect(trendDirection([1, 2, 3], 0, 100)).toBeNull();
    expect(trendDirection([5, 5, 5, 5], 5, 5)).toBeNull(); // shared timestamp: no span
    expect(trendDirection([90, 91, 92, 93], 0, 100)).toBe("up");
    expect(trendDirection([1, 2, 3, 4], 0, 100)).toBe("down");
    expect(trendDirection([1, 2, 90, 91], 0, 100)).toBe("flat");
  });

  it("names the span, the event count and the direction sentence", () => {
    const html = renderToStaticMarkup(
      <OutcomeTrend
        t={t}
        records={[10, 20, 90, 91, 92, 93].map((time, i) =>
          record({ id: `f${i}`, time, status: "failed" }),
        )}
      />,
    );
    const label = firstAriaLabel(html);
    expect(label).toContain("6 trendEvents");
    expect(label).toContain("trendUp");
    expect(html).toContain(">trendUp<"); // the sentence is visible, not only spoken
    expect(html).toContain("6 trendEvents</span>");
  });

  it("says so plainly when there are too few failures to judge", () => {
    const html = renderToStaticMarkup(
      <OutcomeTrend t={t} records={[record({ id: "f", time: 5, status: "failed" })]} />,
    );
    expect(html).toContain(">trendSparse<");
  });
});

describe("rules as settings & clear-records safety", () => {
  it("marks a paused rule at its own switch; ids stay in the disclosure", () => {
    const html = renderSection(
      state({
        activeTab: "rules",
        stats: {
          ...createEmptyStats(),
          totalIntercepted: 3,
          byCategory: { RANGE_CLAMP: 3 },
          breakerOpen: ["RANGE_CLAMP"],
        },
      }),
    );
    expect(html).toContain("Repairs paused"); // chip at the rule's own head, not only the bar
    expect(html).toContain("Recent activity"); // health & ids behind a disclosure
    expect(html).toContain("autoClampRanges · RANGE_CLAMP, PATH_SCOPE");
    expect(html).toContain("<details"); // the disclosure itself is in the tree
    expect(html).toContain("Rule health by category"); // full table still reachable, as a summary
  });

  it("keeps Clear records out of the header and unconfirmed off screen", () => {
    const stats = { ...createEmptyStats(), totalIntercepted: 4 };
    const header = /<header[\s\S]*?<\/header>/.exec(
      renderSection(state({ activeTab: "live", stats })),
    )?.[0];
    expect(header).toBeDefined();
    expect(header).not.toContain("Clear records");
    expect(header).toContain("Refresh");
    const rules = renderSection(state({ activeTab: "rules", stats }));
    expect(rules).toContain("Clear records"); // quiet entry point at the bottom
    expect(rules).toContain("This cannot be undone"); // the promise up front
    expect(rules).not.toContain("This deletes"); // no confirmation until asked
  });

  it("disables Clear when there is nothing to clear", () => {
    const rules = renderSection(state({ activeTab: "rules" }));
    expect(rules).toContain("Clear records");
    expect(rules).toContain('disabled=""');
  });
});
