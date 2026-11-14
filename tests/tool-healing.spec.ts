import { describe, expect, it } from "vitest";
import {
  canonicalCallArgs,
  hasHealSignal,
  healGate,
  healTextBlock,
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
    // Pattern 5's only marker — without it the stream hook (which runs the
    // parser solely on this signal) could never promote a bare [ARGS] call.
    expect(hasHealSignal('Calling read[ARGS]{"file_path":"/a"}')).toBe(true);
  });

  it("stays quiet on healthy prose", () => {
    expect(hasHealSignal("Here is the file content you asked for.")).toBe(false);
    expect(hasHealSignal('const x = "tool"; // no markup')).toBe(false);
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

  it("promotes every glued body inside one marker as its own call (G4 tiling)", () => {
    // Each sibling owns its own span; only the final body extends to the
    // closing tag. No call is lost to span coverage.
    const text = '<tool_call>{"name":"read","arguments":{"file_path":"/a"}}{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const calls = parseToolCallsFromText(text, allow("read", "bash"));
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.name)).toEqual(["read", "bash"]);
    // Spans tile the marker exactly: first body, then final body + closing tag.
    expect(calls[0].span[1]).toBe(calls[1].span[0]);
  });

  it("namespaces generated ids with a per-stream prefix (R4)", () => {
    const text = '<tool_call>{"name":"read","arguments":{"file_path":"/a"}}</tool_call>';
    // Default keeps standalone parsing stable.
    expect(parseToolCallsFromText(text, allow("read"))[0].id).toBe("call_0");
    // A stream-unique prefix namespaces every id in the block…
    const calls = parseToolCallsFromText(text, allow("read"), "heal_ab12cd34ef56");
    expect(calls[0].id).toBe("heal_ab12cd34ef56_0");
  });

  it("keeps Python literals inside string values intact (R5)", () => {
    // The relaxed fallback must not rewrite text that lives inside strings:
    // a command mentioning None/True stays exactly as the model wrote it.
    const text = '<tool_call>{"name":"bash","arguments":{"command":"python -c \\"print(None, True)\\""}}</tool_call>';
    const calls = parseToolCallsFromText(text, allow("bash"));
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({
      command: 'python -c "print(None, True)"',
    });
  });

  it("still promotes single-quoted / unquoted-key / trailing-comma bodies (R5 regression)", () => {
    const text = "<tool_call>{name: read, arguments: {file_path: /a.txt,},}</tool_call>";
    const calls = parseToolCallsFromText(text, allow("read"));
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({ file_path: "/a.txt" });
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

describe("healTextBlock — stream-hook transform (R2/R4)", () => {
  it("promotes a bare [ARGS] call end-to-end and strips its markup", () => {
    const text = 'Calling read[ARGS]{"file_path":"/a.txt"} now.';
    const healed = healTextBlock(text, allow("read"), "heal_test");
    expect(healed).not.toBeNull();
    expect(healed!.calls.length).toBe(1);
    expect(healed!.calls[0].id).toBe("heal_test_0");
    expect(JSON.parse(healed!.calls[0].arguments)).toEqual({ file_path: "/a.txt" });
    // The name is part of the marker syntax (`read[ARGS]{...}`), so it strips
    // with the markup — the promoted call itself carries the name.
    expect(healed!.text).toBe("Calling  now.");
  });

  it("returns null for healthy prose (byte-for-byte passthrough)", () => {
    expect(healTextBlock("Just a normal answer.", allow("read"))).toBeNull();
  });

  it("respects the promotion allowlist", () => {
    const text = 'Calling other[ARGS]{"x":1}';
    // "other" is not allowed → nothing promoted, block passes through.
    expect(healTextBlock(text, allow("read"), "heal_test")).toBeNull();
  });

  it("keeps ids unique across two blocks of one stream (R4)", () => {
    const prefix = "heal_stream";
    // The hook advances the per-stream sequence by each block's call count.
    const a = healTextBlock('Calling read[ARGS]{"file_path":"/a"}', allow("read"), prefix, 0)!;
    const b = healTextBlock(
      'Calling bash[ARGS]{"command":"ls"}',
      allow("bash"),
      prefix,
      a.calls.length,
    )!;
    const ids = [...a.calls, ...b.calls].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no collisions across blocks
    expect(ids).not.toContain("call_0");        // never collides with native ids
  });
});

// G6 — example-bracketed markup stays TEXT (second review round, 2026-11-14;
// Qwen3 parser report: quoted examples read as executable calls).
describe("G6 — quoted examples are data, not calls", () => {
  it("suppresses a double-quoted <function=…> example", () => {
    const text =
      'Use "<function=read><parameter=file_path>a.txt</parameter></function>" to load a file.';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("suppresses a curly-quoted tool_call example", () => {
    const text =
      'the model says “<tool_call>{"name":"read","arguments":{}}</tool_call>”';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("suppresses a parenthesized example", () => {
    const text = '(<tool_call>{"name":"read","arguments":{"file_path":"a.txt"}}</tool_call>)';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(0);
  });

  it("still promotes the same call unquoted (control)", () => {
    const text = '<function=read><parameter=file_path>a.txt</parameter></function>';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(1);
  });

  it("a real call followed by a period is not an example (one-sided never suppresses)", () => {
    const text = 'Loading now.\n<tool_call>{"name":"read","arguments":{}}</tool_call>.';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(1);
  });

  it("a real call preceded by a colon is not an example", () => {
    const text = 'Call it: <function=read><parameter=file_path>a.txt</parameter></function>';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(1);
  });

  it("Mistral array tiling is unaffected (brackets are not example quotes)", () => {
    const text =
      '[TOOL_CALLS][{"name":"read","arguments":{"file_path":"a"}},{"name":"read","arguments":{"file_path":"b"}}]';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(2);
  });

  it("glued bodies inside one tool_call marker are unaffected", () => {
    const text =
      '<tool_call>{"name":"read","arguments":{"f":"a"}}{"name":"read","arguments":{"f":"b"}}</tool_call>';
    expect(parseToolCallsFromText(text, allow("read"))).toHaveLength(2);
  });
});

describe("canonicalCallArgs", () => {
  it("ignores key order and whitespace", () => {
    expect(canonicalCallArgs('{"b":1,"a":2}')).toBe(canonicalCallArgs({ a: 2, b: 1 }));
  });

  it("recurses into nested objects and arrays", () => {
    expect(canonicalCallArgs('{"o":{"b":[1,{"d":4,"c":3}]},"a":0}')).toBe(
      canonicalCallArgs({ a: 0, o: { b: [1, { c: 3, d: 4 }] } }),
    );
  });

  it("unparseable strings canonicalize to themselves", () => {
    expect(canonicalCallArgs("not json")).toBe("not json");
    expect(canonicalCallArgs("not json")).not.toBe(canonicalCallArgs("also not json"));
  });
});
