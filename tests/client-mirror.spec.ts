/**
 * Client-mirror PARITY tests — the guard the dashboard used to lack.
 *
 * src/client/mirror.ts exists so this file can import both the server's
 * rule taxonomy and the browser bundle's copy of it and fail the suite
 * whenever they disagree. Without these tests, adding a stage, flag, or
 * rule on the server silently drifts the dashboard (the client bundle is
 * self-contained and DoctorSection.tsx itself cannot be imported here —
 * it depends on React).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, HEAL_CATEGORIES, type ConfigFlag, type HealCategory } from "../src/types.ts";
import { CATEGORY_LABELS, CATEGORY_TO_FLAG } from "../src/stages/index.ts";
import {
  CATEGORY_TO_RULE,
  FIX_PROPOSE_MIN_COUNT,
  FIX_PROPOSE_MIN_SPAN_MS,
  RULE_FLAGS,
  TEXT_RULE_HINTS,
  fixEligible,
  hintRule,
  normalizeErrorSignature,
  proposeFix,
} from "../src/support/error-signatures.ts";
import {
  CATEGORY_LABELS as M_LABELS,
  CATEGORY_ORDER as M_ORDER,
  CATEGORY_TO_RULE as M_RULE,
  CATEGORY_TO_FLAG as M_FLAG,
  RULE_FLAGS as M_FLAGS,
  TEXT_RULE_HINTS as M_HINTS,
  FIX_PROPOSE_MIN_COUNT as M_MIN_COUNT,
  FIX_PROPOSE_MIN_SPAN_MS as M_MIN_SPAN,
  RULES as M_RULES,
  RULE_GROUPS as M_RULE_GROUPS,
  fixEligible as mEligible,
  hintRule as mHintRule,
  normalizeErrorSignature as mSignature,
  proposeFix as mProposeFix,
} from "../src/client/mirror.ts";
import { en } from "../src/client/locales.ts";

const hintShape = (hints: ReadonlyArray<{ rule: number; test: RegExp }>) =>
  hints.map(({ rule, test }) => ({ rule, source: test.source, flags: test.flags }));

describe("client mirror — category taxonomy", () => {
  it("covers exactly the recordable categories, in registry order", () => {
    expect([...M_ORDER]).toEqual([...HEAL_CATEGORIES]);
  });

  it("panel labels match the server labels verbatim", () => {
    // Server labels carry the "(CATEGORY)" suffix; the panel shows the short
    // name. One derivation rule, asserted for every category: strip suffix.
    for (const category of HEAL_CATEGORIES) {
      const server = CATEGORY_LABELS[category];
      expect(server, `server label for ${category}`).toBeDefined();
      expect(M_LABELS[category], `client label for ${category}`).toBe(
        server.replace(` (${category})`, ""),
      );
    }
  });

  it("category-to-rule matches the registry-derived table", () => {
    expect({ ...M_RULE }).toEqual({ ...CATEGORY_TO_RULE });
  });

  it("category-to-flag matches the registry-derived table", () => {
    expect({ ...M_FLAG }).toEqual({ ...CATEGORY_TO_FLAG });
  });

  it("rule-to-flags matches the server derivation, per rule in order", () => {
    expect([...M_FLAGS.keys()].sort((a, b) => a - b)).toEqual(
      [...RULE_FLAGS.keys()].sort((a, b) => a - b),
    );
    for (const [rule, flags] of RULE_FLAGS) {
      expect([...(M_FLAGS.get(rule) ?? [])], `flags of rule ${rule}`).toEqual([...flags]);
    }
  });

  it("error-text hint patterns match the server table exactly", () => {
    expect(hintShape(M_HINTS)).toEqual(hintShape(TEXT_RULE_HINTS));
  });
});

describe("client mirror — rule cards", () => {
  it("every config toggle has exactly one rule card", () => {
    const flags = M_RULES.map((card) => card.flag);
    expect([...flags].sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
  });

  it("every stage-owning flag has a card (the fix-proposal flow can name it)", () => {
    const carded = new Set<string>(M_RULES.map((card) => card.flag));
    for (const flag of Object.values(CATEGORY_TO_FLAG) as ConfigFlag[]) {
      expect(carded.has(flag), `card for ${flag}`).toBe(true);
    }
  });

  it("every card's locale keys exist in the dictionary", () => {
    const dictionary = en as Record<string, unknown>;
    for (const card of M_RULES) {
      expect(typeof dictionary[card.titleKey], card.titleKey).toBe("string");
      expect(typeof dictionary[card.descKey], card.descKey).toBe("string");
    }
  });

  it("the rules-tab purpose groups partition the rule cards exactly", () => {
    const grouped = M_RULE_GROUPS.flatMap((g) => [...g.flags]);
    // Every flag exactly once — grouping is layout, never a hidden toggle set.
    expect([...grouped].sort()).toEqual(M_RULES.map((c) => c.flag).sort());
    const dictionary = en as Record<string, unknown>;
    for (const group of M_RULE_GROUPS) {
      expect(typeof dictionary[group.titleKey], group.titleKey).toBe("string");
    }
  });
});

describe("client mirror — candidate logic behaves identically", () => {
  it("fix-proposal thresholds match the server", () => {
    expect([M_MIN_COUNT, M_MIN_SPAN]).toEqual([FIX_PROPOSE_MIN_COUNT, FIX_PROPOSE_MIN_SPAN_MS]);
  });

  it("fixEligible agrees on the boundary", () => {
    const T = 1_700_000_000_000;
    for (const [count, span] of [
      [2, FIX_PROPOSE_MIN_SPAN_MS],
      [FIX_PROPOSE_MIN_COUNT, FIX_PROPOSE_MIN_SPAN_MS - 1],
      [FIX_PROPOSE_MIN_COUNT, FIX_PROPOSE_MIN_SPAN_MS],
      [FIX_PROPOSE_MIN_COUNT + 1, FIX_PROPOSE_MIN_SPAN_MS + 1],
    ] as const) {
      expect(mEligible(count, T, T + span)).toBe(fixEligible(count, T, T + span));
    }
  });

  it("proposeFix agrees for every verdict × rule × config combination", () => {
    // null-config handling is client-only (unloaded dashboard state); the
    // server is only ever called with a concrete config or none at all.
    const configs = [
      undefined,
      { ...DEFAULT_CONFIG },
      { ...DEFAULT_CONFIG, autoFuzzyEdit: false },
      { ...DEFAULT_CONFIG, autoClampRanges: false, autoWrapRunCode: false },
    ];
    for (const verdict of ["attempted-failed", "possible-existing", "new-rule-candidate"] as const) {
      for (const ruleHint of [undefined, 1, 2, 3, 4, 7, 9, 10, 42]) {
        for (const config of configs) {
          expect(
            mProposeFix(verdict, ruleHint, config),
            `${verdict} rule=${ruleHint}`,
          ).toEqual(proposeFix(verdict, ruleHint, config));
        }
      }
    }
  });

  it("hintRule returns the same rule for representative and novel texts", () => {
    const samples = [
      "Unknown tool: bash",
      "the tool foo was not registered",
      "view_range [1, 999] is out of range",
      "FS_STALE_VERSION: file changed since read",
      "expected a number for timeout_ms",
      'cannot read "C:\\proj\\src": not a regular file',
      "EISDIR: illegal operation on a directory, read",
      "<tool_call>example</tool_call>",
      "ENOENT: no such file or directory, open 'x'",
      "a totally novel failure nobody has catalogued",
      "",
    ];
    for (const text of samples) {
      expect(mHintRule(text), text).toBe(hintRule(text));
    }
  });

  it("normalizeErrorSignature yields one signature per pattern on both sides", () => {
    const long = "timeout waiting for " + "segment/".repeat(60);
    const samples = [
      "",
      'cannot read "C:\\Users\\x\\src": not a regular file at line 42',
      "failed id 3f2b8c9d-1111-2222-3333-444455556666 code 500 v1.2.3",
      "path /home/user/docs/a.txt rejected by `policy` check",
      long,
    ];
    for (const text of samples) {
      expect(mSignature(text), text.slice(0, 40)).toBe(normalizeErrorSignature(text));
    }
  });
});

// Drift tripwire: a stage's CATEGORY_TO_RULE entry missing on the client.
// Not a test to "fix" by editing the mirror blindly — the mirror update is
// the intended work of the change that adds a rule.
describe("client mirror — registration doctrine", () => {
  it("every rule number on the server is reachable from a client card chain", () => {
    const serverRules = new Set<number>(Object.values(CATEGORY_TO_RULE));
    const cardedFlags = new Set<string>(M_RULES.map((card) => card.flag));
    for (const category of Object.keys(CATEGORY_TO_RULE) as HealCategory[]) {
      const flag = CATEGORY_TO_FLAG[category];
      // Every rule-owning category must name a flag, and that flag a card —
      // otherwise the dashboard shows a rule with no way to turn it on.
      expect(flag, `flag for ${category}`).toBeDefined();
      expect(cardedFlags.has(flag as string), `card for ${String(flag)}`).toBe(true);
    }
    expect(serverRules.size).toBeGreaterThan(0);
  });
});
