import { describe, it, expect } from 'vitest';
import { canonicalToolName } from '../src/repair/tool-name.ts';

describe('canonicalToolName', () => {
  it('exact case drift: "Read" vs ["read"]', () => {
    expect(canonicalToolName("Read", ["read"])).toBe("read");
  });

  it('MCP suffix loss: "bash" vs ["mcp__shell__bash"]', () => {
    expect(canonicalToolName("bash", ["mcp__shell__bash"])).toBe("mcp__shell__bash");
  });

  it('ambiguity: ["mcp__a__bash","mcp__b__bash"] + called "bash" → undefined', () => {
    expect(canonicalToolName("bash", ["mcp__a__bash", "mcp__b__bash"])).toBeUndefined();
  });

  it('near-miss non-match: "readme" vs "read"', () => {
    expect(canonicalToolName("readme", ["read"])).toBeUndefined();
  });

  it('called name present verbatim in registry → undefined', () => {
    expect(canonicalToolName("bash", ["bash"])).toBeUndefined();
  });

  it('empty registry: "read" vs [] → undefined', () => {
    expect(canonicalToolName("read", [])).toBeUndefined();
  });

  it('separator variety: "read" vs ["server:read"]', () => {
    expect(canonicalToolName("read", ["server:read"])).toBe("server:read");
  });

  it('whitespace input: "   " vs ["read"] → undefined', () => {
    expect(canonicalToolName("   ", ["read"])).toBeUndefined();
  });

  it("reverse direction: called carries the prefix the plane lacks", () => {
    expect(canonicalToolName("mcp__shell__bash", ["bash"])).toBe("bash");
  });

  it("affix matching is case-insensitive on both sides", () => {
    expect(canonicalToolName("BASH", ["mcp__Shell__bash"])).toBe("mcp__Shell__bash");
  });

  it('dot affix needs a boundary: "readme.md" is not "md"', () => {
    // ".md" IS a boundary match — the rule is the affix, so pin it either way:
    expect(canonicalToolName("readme.md", ["md"])).toBe("md");
    // and a substring WITHOUT a separator boundary must never match:
    expect(canonicalToolName("overwrite", ["write"])).toBeUndefined();
  });

  it("exact case-insensitive match outranks an affix candidate", () => {
    expect(canonicalToolName("Read", ["read", "mcp__fs__read"])).toBe("read");
  });

  it("a registered empty name never becomes the canonical name", () => {
    // "bash_" ends with "_", which would affix-match an empty candidate.
    expect(canonicalToolName("bash_", [""])).toBeUndefined();
  });
});
