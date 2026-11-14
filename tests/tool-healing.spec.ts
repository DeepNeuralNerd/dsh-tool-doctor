import { describe, expect, it } from "vitest";
import {
  hasHealSignal,
  healGate,
  parseToolCallsFromText,
  stripToolCallMarkup,
} from "../src/support/tool-healing.ts";

const TOOLS = [
  { name: "read", description: "Read a file" },
  { name: "bash", description: "Run a command" },
];

function allow(...names: string[]): Set<string> {
  return new Set(names);
}

describe("hasHealSignal", () => {
  it("detects every explicit marker family", () => {
    expect(hasHealSignal('<tool_call>{"name":"read"}</tool_call>')).toBe(true);
    expect(hasHealSignal("<|tool_call>call : read{\"file_path\":\"/a\"}<tool_call|>")).toBe(true);
    expect(hasHealSignal('<function=read>\n<parameter=file_path>/a</parameter>\n</function>')).toBe(true);
    expect(hasHealSignal('[TOOL_CALLS]\n[{"name":"bash","arguments":{"command":"ls"}}]')).toBe(true);
    expect(hasHealSignal('<minimax:tool_call>read{"file_path":"/a"}</minimax:tool_call>')).toBe(true);
  });

  it("stays quiet on healthy prose and on the markerless bare form", () => {
    expect(hasHealSignal("Here is the file content you asked for.")).toBe(false);
    expect(hasHealSignal('const x = "tool"; // no markup')).toBe(false);
    // Pattern 5 (name[ARGS]{json}) has no explicit marker, so it never trips
    // the fast pre-filter — the parser still promotes it when it runs.
    expect(hasHealSignal('Calling read [ARGS] {"file_path": "/a"}')).toBe(false);
  });
});

describe("healGate", () => {
  it("allows a stream that declares tools and returns the allowlist set", () => {
    const gate = healGate({ tools: TOOLS });
    expect(gate).not.toBeNull();
    expect((gate as Set<string>).has("read")).toBe(true);
    expect((gate as Set<string>).has("bash")).toBe(true);
  });

  it("refuses a stream with no tool surface (null)", () => {
    expect(healGate(undefined)).toBeNull();
    expect(healGate({})).toBeNull();
    expect(healGate({ tools: [] })).toBeNull();
  });

  it("honors an explicit none choice", () => {
    expect(healGate({ tools: TOOLS, tool_choice: "none" })).toBeNull();
  });

  it("refuses when response_format constrains decoding", () => {
    expect(healGate({ tools: TOOLS, response_format: { type: "json_object" } })).toBeNull();
    // A plain text format does not constrain.
    expect(healGate({ tools: TOOLS, response_format: { type: "text" } })).not.toBeNull();
  });

  it("intersects a forced tool_choice.function.name", () => {
    const gate = healGate({
      tools: TOOLS,
      tool_choice: { function: { name: "bash" } },
    });
    expect(gate).not.toBeNull();
    expect((gate as Set<string>).has("bash")).toBe(true);
    expect((gate as Set<string>).has("read")).toBe(false);
  });

  it("accepts a bare tools array for back-compat", () => {
    const gate = healGate(TOOLS);
    expect(gate).not.toBeNull();
  });
});

describe("parseToolCallsFromText — the six patterns", () => {
  it("parses JSON tool_call markup (pattern 1)", () => {
    const text = 'Sure! <tool_call>\n{"name":"read","arguments":{"file_path":"/a.txt"}}\n</tool_call>';
    const calls = parseToolCallsFromText(text, allow("read"));
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("read");
    expect(JSON.parse(calls[0].arguments)).toEqual({ file_path: "/a.txt" });
  });

  it("splits several glued JSON bodies in one marker into separate calls", () => {
    // The parser tiles the span: each promoted call owns its own body, so a
    // second body inside the first call's coverage is that call's data (G4).
    const text = '<tool_call>{"name":"read","arguments":{"file_path":"/a"}}</tool_call> <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const calls = parseToolCallsFromText(text, allow("read", "bash"));
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.name)).toEqual(["read", "bash"]);
  });

  it("promotes the last glued body when two are glued inside one marker (G4 tiling)", () => {
    // The first body's span is covered by its own marker region, so only the
    // final body — which owns the closing tag — gets promoted.
    const text = '<tool_call>{"name":"read","arguments":{"file_path":"/a"}}{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const calls = parseToolCallsFromText(text, allow("read", "bash"));
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("bash");
  });

  it("parses Gemma native tool_call (pattern 2)", () => {
    const text = '<|tool_call>call : read{"file_path":"/b.txt"}<tool_call|>';
    const calls = parseToolCallsFromText(text, allow("read"));
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("read");
  });

  it("parses function/parameter markup (pattern 3)", () => {
    const text = [
      '<function=read>',
      "<parameter=file_path>/c.txt</parameter>",
      "</function>",
    ].join("\n");
    const calls = parseToolCallsFromText(text, allow("read"));
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({ file_path: "/c.txt" });
  });

  it("parses a TOOL_CALLS JSON array (pattern 4)", () => {
    const text = '[TOOL_CALLS]\n[{"name":"bash","arguments":{"command":"ls"}}]';
    const calls = parseToolCallsFromText(text, allow("bash"));
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("bash");
  });

  it("parses a bare bracket call (pattern 5)", () => {
    // The regex requires the brace to follow [ARGS] with no space in between.
    const text = 'Calling read[ARGS]{"file_path":"/d.txt"}';
    const calls = parseToolCallsFromText(text, allow("read"));
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({ file_path: "/d.txt" });
  });

  it("does not promote a spaced bare form (regex requires [ARGS] directly before the brace)", () => {
    const text = 'Calling read [ARGS] {"file_path":"/d.txt"}';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("parses a minimax block span (pattern 6)", () => {
    const text = '<minimax:tool_call>read{"file_path":"/e.txt"}</minimax:tool_call>';
    const calls = parseToolCallsFromText(text, allow("read"));
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("read");
  });

  it("parses multiple independent markers in one block", () => {
    const text = [
      '<tool_call>{"name":"read","arguments":{"file_path":"/a"}}</tool_call>',
      '<minimax:tool_call>bash{"command":"ls"}</minimax:tool_call>',
    ].join("\n");
    const calls = parseToolCallsFromText(text, allow("read", "bash"));
    expect(calls.length).toBe(2);
  });
});

describe("parseToolCallsFromText — the five data guards", () => {
  it("G1: skips a marker inside a think block", () => {
    const text = "I'm thinking... \n<thinking>\n<tool_call>{\"name\":\"read\",\"arguments\":{\"file_path\":\"/a\"}}\n\nDone.";
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("G1: an unclosed trailing think block runs to EOF and swallows the marker", () => {
    const text = "Let me reason.\n<thinking>\n<tool_call>{\"name\":\"read\",\"arguments\":{\"file_path\":\"/a\"}}";
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("G1: a [THINK] block also shields its markers", () => {
    const text = "[THINK]\n<tool_call>{\"name\":\"read\",\"arguments\":{\"file_path\":\"/a\"}}\n[/THINK]";
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("G2: skips a marker inside a code fence (quoted syntax)", () => {
    const text = "```\n<tool_call>{\"name\":\"read\",\"arguments\":{}}\n</tool_call>\n```";
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("G3: skips a lone tag in backticks (names the format)", () => {
    const text = "Use `<function=read>` style when calling.";
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("drops a call whose tool is not in the allowlist", () => {
    const text = '<tool_call>{"name":"secret_tool","arguments":{}}</tool_call>';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("G5: does not promote a bare execution-class name", () => {
    // A markerless `python [ARGS] {...}` rehearsal is data, not a call.
    const text = "python [ARGS] {\"code\": \"print(1)\"}";
    expect(parseToolCallsFromText(text)).toHaveLength(0);
  });

  it("drops arguments that are not valid JSON objects", () => {
    const text = '<tool_call>{not json</tool_call>';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("never heals when the block has no markup at all", () => {
    expect(parseToolCallsFromText("plain prose only", allow("read"))).toHaveLength(0);
  });
});

describe("stripToolCallMarkup", () => {
  it("removes healed markup but keeps surrounding prose", () => {
    const text = 'Let me check.\n<tool_call>{"name":"read","arguments":{"file_path":"/a"}}\n</tool_call>\nDone.';
    const stripped = stripToolCallMarkup(text, allow("read"));
    expect(stripped).toContain("Let me check.");
    expect(stripped).toContain("Done.");
    expect(stripped).not.toContain("<tool_call>");
  });

  it("returns the text unchanged when nothing matched", () => {
    const text = "no markup here";
    expect(stripToolCallMarkup(text, allow("read"))).toBe(text);
  });

  it("keeps a marker that was not promoted (allowlist miss)", () => {
    const text = '<tool_call>{"name":"other","arguments":{}}</tool_call>';
    // "other" is not allowed → the marker stays in place.
    expect(stripToolCallMarkup(text, allow("read"))).toContain("other");
  });
});
