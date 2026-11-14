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
  DoctorSection,
  OutcomeTrend,
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
