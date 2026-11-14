/**
 * Response-side tool-call healing: parse model-emitted tool-call markup from
 * streamed text and promote it to structured tool-call blocks.
 *
 * Ported from Unsloth Studio's `studio/backend/core/tool_healing.py` (core
 * parser) and `studio/backend/core/inference/passthrough_healing.py`
 * (streaming gate). Both Python modules are stdlib-only; this TS port keeps
 * the same dependency-free design — no external packages, just built-in
 * `RegExp` and `JSON`.
 *
 * Supported markup patterns (promotion):
 *   1. `<tool_call>{json}</tool_call>`  (JSON-wrapped; also `<|content_invoke_tool_json|>`;
 *      several `{...}` bodies glued in one marker split into one call each)
 *   2. `<|tool_call>call : name{json}<tool_call|>`  (Gemma native; |"|" string quotes normalised)
 *   3. `<function=name><parameter=key>value</parameter>...</function>`  (param-tag)
 *   4. `[TOOL_CALLS][{json}, ...]`  (Mistral array; comma-less `{...}{...}` tolerated)
 *   5. `name[ARGS]{json}`  (bare rehearsal / bracket-tag; v11 `[CALL_ID]` lookbehind)
 *   6. `<minimax:tool_call>name{json}</minimax:tool_call>`  (minimax block span)
 *
 * Guards (a marker is DATA, not a call, and is skipped when it):
 *   G1. sits inside a think block  (`think` / `thinking` / `[THINK]`)
 *   G2. sits inside a code fence   (``` / ~~~)  — quoted syntax, not a call
 *   G3. is a lone tag in backticks (`` `<function=name>` `` names the format)
 *   G4. is nested inside another marker's coverage (even one that failed to parse)
 *   G5. is a bare (markerless) execution-class name: python/terminal/edit_file/mcp__*
 *
 * `healGate` mirrors passthrough_healing.heal_gate: healing is off when
 * `tool_choice == "none"`, when `response_format` constrains decoding
 * (anything other than null / `{"type":"text"}`), or when no declared tool
 * survives a forced `tool_choice.function.name` intersection.
 *
 * Intentionally NOT ported: the streaming hold/flush buffer (we heal at
 * block-end, where the whole block is available, so no chunk-boundary
 * buffering is needed).
 *
 * @module dsh-tool-doctor/support/tool-healing
 */

// ─── Signal detection (fast pre-filter) ─────────────────────────────────────

const HEAL_SIGNALS: readonly string[] = [
  "<tool_call>",
  "<|tool_call>",
  "<function=",
  "[TOOL_CALLS]",
  "<|content_invoke_tool_json|>",
  "<minimax:tool_call>",
  // Pattern 5's only marker. Without it the stream hook (which runs the parser
  // solely on this signal) could never promote a bare `name[ARGS]{json}` call.
  "[ARGS]",
];

/** Fast check: does this text contain any known tool-call markup signal? */
export function hasHealSignal(text: string): boolean {
  for (const s of HEAL_SIGNALS) {
    if (text.includes(s)) return true;
  }
  return false;
}

// ─── Parsed tool-call shape (OpenAI-compatible) ─────────────────────────────

export interface ParsedToolCall {
  /** Unique id for this call, e.g. "call_0". */
  id: string;
  /** Tool name, e.g. "read_file". */
  name: string;
  /** JSON-encoded arguments string, e.g. `{"path":"foo.txt"}`. */
  arguments: string;
  /** Character span in the source text: [start, end). */
  span: [number, number];
}

// ─── Regex constants ────────────────────────────────────────────────────────

const RE_JSON_TOOL = /(?:<tool_call>|<\|content_invoke_tool_json\|>)\s*(\{)/g;
const RE_GEMMA_TOOL = /<\|tool_call>\s*call\s*:\s*([\w.\-]+)\s*(\{)/g;
const RE_MINIMAX_TOOL = /<minimax:tool_call>\s*([\w.\-]+)\s*(\{)/g;
const RE_FUNC_TOOL = /<function=([\w-]+)>\s*/g;
const RE_MISTRAL_ARRAY = /\[TOOL_CALLS\]\s*(?=\[)/g;
// Lookbehind keeps a v11 `[CALL_ID]` id from being misread as a bare name.
const RE_BARE_BRACKET = /(?<!\[CALL_ID\])\b([\w-]+)\[ARGS\]\s*(?=\{)/g;

const RE_PARAM = /<parameter=([\w-]+)>([\s\S]*?)<\/parameter>/g;

// G1 — think blocks (an unclosed trailing block runs to EOF).
const RE_THINK_BLOCK =
  /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)|\[THINK\][\s\S]*?(?:\[\/THINK\]|$)/g;

// G2 — code fences (``` / ~~~, including an unclosed trailing fence).
const RE_CODE_FENCE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;

// G3 — single-backtick inline code spans (a lone tool tag inside them).
const RE_INLINE_CODE = /`([^`\n]+)`/g;

/** Tool-family tag prefixes that mark a "lone tag names the format" mention. */
const TOOL_TAG_PREFIXES: readonly string[] = [
  "<tool",
  "</tool",
  "<function",
  "</function",
  "<param",
  "</param",
  "<arg_",
  "</arg_",
  "<minimax:",
  "</minimax:",
  "<|",
  "<｜",
  "[TOOL_CALLS]",
  "[/TOOL_CALLS]",
  "[ARGS]",
  "[/ARGS]",
  "[CALL_ID]",
];

// G5 — execution-class names a bare (markerless) form must not promote.
const EXECUTION_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "python",
  "terminal",
  "edit_file",
]);
const MCP_TOOL_PREFIX = "mcp__";

// ─── Delimiter balancing ────────────────────────────────────────────────────

/**
 * Index of the delimiter closing the one opened at `start`, or -1. One scanner
 * for both shapes: brace bodies (JSON) and bracket arrays (Mistral). String
 * state tracks plain double quotes, Gemma |"|" quotes, and escapes so a
 * delimiter inside a string never balances against its opener.
 */
function balancedEnd(
  text: string,
  start: number,
  openers: string,
  closers: string,
): number {
  if (!openers.includes(text[start] ?? "")) return -1;
  let depth = 0;
  let inString = false; // inside "..."
  let inGemma = false; // inside a |"|"..."|"|" Gemma-quoted string
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inGemma) {
      if (ch === "|" && text[i + 1] === '"' && text[i + 2] === "|") {
        inGemma = false;
        i += 2;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "|" && text[i + 1] === '"' && text[i + 2] === "|") {
      inGemma = true;
      i += 2;
    } else if (openers.includes(ch)) depth++;
    else if (closers.includes(ch)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const balancedBraceEnd = (text: string, openBrace: number): number =>
  balancedEnd(text, openBrace, "{", "}");

const balancedBracketEnd = (text: string, start: number, bracesCount = true): number =>
  balancedEnd(text, start, bracesCount ? "[{" : "[", bracesCount ? "]}" : "]");

// ─── JSON parsing ───────────────────────────────────────────────────────────

/**
 * Gemma models delimit string keys/values with |"|" ... |"|" instead of
 * "..." — normalise to plain double quotes for JSON parsing.
 */
function gemmaNormalise(raw: string): string {
  return raw.includes('|"|') ? raw.replace(/\|"|/g, '"') : raw;
}

/**
 * Minimal token-aware relaxed JSON parser: handles single quotes, unquoted
 * keys, Python-style True/False/None, and trailing commas. The rewrite walks
 * tokens instead of applying global regexes, so literal text inside strings is
 * never rewritten — a command containing `None` or `True` stays intact.
 * Returns null when the body cannot be parsed losslessly; the caller then
 * leaves it unpromoted rather than guessing.
 */
function relaxedJsonParse(raw: string): Record<string, unknown> | null {
  let i = 0;
  const n = raw.length;

  function skipWs(): void {
    while (i < n && " \t\r\n".includes(raw[i]!)) i++;
  }

  /** Read a double- or single-quoted string. Returns [value, terminated]. */
  function readString(quote: string): [string, boolean] {
    let out = "";
    while (i < n) {
      const ch = raw[i]!;
      if (ch === "\\" && i + 1 < n) {
        const esc = raw[i + 1]!;
        switch (esc) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "/": out += "/"; break;
          case '"': out += '"'; break;
          case "'": out += "'"; break;
          case "\\": out += "\\"; break;
          default: out += esc; // Unknown escape: keep the character.
        }
        i += 2;
        continue;
      }
      if (ch === quote) {
        i++;
        return [out, true];
      }
      out += ch;
      i++;
    }
    return [out, false]; // Unterminated string.
  }

  /** Read a bare (unquoted) token up to the next structural character. */
  function readBare(): string | null {
    const start = i;
    while (i < n && !",:{}[] \t\r\n".includes(raw[i]!)) i++;
    if (i === start) return null;
    return raw.slice(start, i);
  }

  function parseValue(): unknown | undefined {
    skipWs();
    const ch = raw[i];
    if (ch === undefined) return undefined;
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"' || ch === "'") {
      const [val, closed] = readString(ch);
      if (!closed) return undefined;
      return val;
    }
    // Bare literal: true/false/null/True/False/None or a number.
    const bare = readBare();
    if (bare === null || bare.length === 0) return undefined;
    switch (bare.toLowerCase()) {
      case "true": return true;
      case "false": return false;
      case "null":
      case "none": return null;
    }
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(bare)) return Number(bare);
    // Unquoted string value (last resort).
    return bare;
  }

  function parseObject(): Record<string, unknown> | undefined {
    i++; // consume {
    const obj: Record<string, unknown> = {};
    for (;;) {
      skipWs();
      if (raw[i] === "}") { i++; return obj; } // empty object or trailing comma
      const ch = raw[i];
      let key: string | undefined;
      if (ch === '"' || ch === "'") {
        const [val, closed] = readString(ch);
        if (!closed) return undefined;
        key = val;
      } else {
        const bare = readBare();
        if (bare === null || bare.length === 0) return undefined;
        key = bare;
      }
      skipWs();
      if (raw[i] !== ":") return undefined;
      i++; // consume :
      const value = parseValue();
      if (value === undefined) return undefined;
      obj[key] = value;
      skipWs();
      if (raw[i] === ",") { i++; continue; }
      if (raw[i] === "}") { i++; return obj; }
      return undefined; // Malformed.
    }
  }

  function parseArray(): unknown[] | undefined {
    i++; // consume [
    const arr: unknown[] = [];
    for (;;) {
      skipWs();
      if (raw[i] === "]") { i++; return arr; } // empty array or trailing comma
      const value = parseValue();
      if (value === undefined) return undefined;
      arr.push(value);
      skipWs();
      if (raw[i] === ",") { i++; continue; }
      if (raw[i] === "]") { i++; return arr; }
      return undefined; // Malformed.
    }
  }

  const value = parseValue();
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Parse the brace body opening at `pos`, strict first then relaxed. */
function tryParseJsonAt(
  text: string,
  pos: number,
): { obj: Record<string, unknown>; end: number } | null {
  const braceEnd = balancedBraceEnd(text, pos);
  if (braceEnd < 0) return null;
  const raw = text.slice(pos, braceEnd + 1);
  const norm = gemmaNormalise(raw);
  for (const candidate of [raw, norm]) {
    try {
      const obj: unknown = JSON.parse(candidate);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        return { obj: obj as Record<string, unknown>, end: braceEnd + 1 };
      }
    } catch {
      // Not valid JSON as-is — try the next candidate.
    }
  }
  const relaxed = relaxedJsonParse(norm);
  if (relaxed) return { obj: relaxed, end: braceEnd + 1 };
  return null;
}

/**
 * Decode a Mistral/Ollama array body element-by-element. Tolerates the
 * comma-less `{...}{...}` form (which a whole-array `JSON.parse` rejects), and
 * a per-object relaxed fallback. Returns each decoded object and the index
 * just past its closing brace.
 */
function decodeArrayItems(
  text: string,
  bodyStart: number,
  bodyEnd: number,
): { items: unknown[]; ends: number[] } {
  const items: unknown[] = [];
  const ends: number[] = [];
  let i = text.indexOf("[", bodyStart);
  if (i < 0) return { items, ends };
  i += 1;
  while (i < bodyEnd) {
    while (i < bodyEnd && " \t\r\n,".includes(text[i]!)) i++;
    if (i >= bodyEnd || text[i] === "]") break;
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const be = balancedBraceEnd(text, i);
    if (be < 0 || be >= bodyEnd) break;
    const raw = text.slice(i, be + 1);
    let obj: unknown = null;
    const norm = gemmaNormalise(raw);
    try {
      obj = JSON.parse(raw);
    } catch {
      try {
        obj = JSON.parse(norm);
      } catch {
        obj = relaxedJsonParse(norm);
      }
    }
    if (obj === null) break;
    items.push(obj);
    ends.push(be + 1);
    i = be + 1;
  }
  return { items, ends };
}

// ─── Guard span extraction ──────────────────────────────────────────────────

type Span = [number, number];

function collectSpans(text: string, re: RegExp): Span[] {
  const spans: Span[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** G1 — think-block spans, so markers inside them are skipped. */
const thinkSpans = (text: string): Span[] => collectSpans(text, RE_THINK_BLOCK);

/** G2 — code-fence spans, so quoted markup is skipped. */
function codeSpanSpans(text: string): Span[] {
  if (!text.includes("```") && !text.includes("~~~")) return [];
  return collectSpans(text, RE_CODE_FENCE);
}

/**
 * G3 — lone tool tags inside single-backtick inline code spans (backticks
 * excluded). `` `<function=name>` `` names the format, not a call.
 */
function tagMentionSpans(text: string): Span[] {
  if (!text.includes("`")) return [];
  const spans: Span[] = [];
  RE_INLINE_CODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_INLINE_CODE.exec(text)) !== null) {
    const innerStart = m.index + 1;
    const inner = (m[1] ?? "").trim();
    if (TOOL_TAG_PREFIXES.some((p) => inner.startsWith(p))) {
      spans.push([innerStart, innerStart + (m[1]?.length ?? 0)]);
    }
  }
  return spans;
}

function inSpan(pos: number, spans: Span[]): boolean {
  for (const [s, e] of spans) {
    if (pos >= s && pos < e) return true;
  }
  return false;
}

/** G5 — is `name` an execution-class (or MCP) name a bare form must not run? */
function isExecutionClassName(name: string): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  return EXECUTION_CLASS_TOOL_NAMES.has(n) || n.startsWith(MCP_TOOL_PREFIX);
}

/**
 * G4 — marker coverage regions. Each opener maps to its balanced end (close
 * tag when present, else to-EOF for an unbalanced opener), so a marker nested
 * inside another call's coverage — even one that failed to parse — is treated
 * as that call's data, not a sibling.
 */
function buildMarkerCoverage(text: string): Span[] {
  const regions: Span[] = [];
  const pushBrace = (start: number, bodyStart: number): void => {
    const be = balancedBraceEnd(text, bodyStart);
    regions.push([start, be >= 0 ? be + 1 : text.length]);
  };

  // The three brace-body patterns all end in the opening `{` itself, so the
  // body starts one character before each span's end.
  for (const [start, end] of collectSpans(text, RE_JSON_TOOL)) pushBrace(start, end - 1);
  for (const [start, end] of collectSpans(text, RE_GEMMA_TOOL)) pushBrace(start, end - 1);
  for (const [start, end] of collectSpans(text, RE_MINIMAX_TOOL)) pushBrace(start, end - 1);

  RE_FUNC_TOOL.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = RE_FUNC_TOOL.exec(text)) !== null) {
    const bodyStart = fm.index + fm[0].length;
    const ci = text.indexOf("</function>", bodyStart);
    regions.push([fm.index, ci >= 0 ? ci + "</function>".length : text.length]);
  }

  RE_MISTRAL_ARRAY.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = RE_MISTRAL_ARRAY.exec(text)) !== null) {
    const bodyStart = am.index + am[0].length;
    const be = balancedBracketEnd(text, bodyStart, true);
    regions.push([am.index, be >= 0 ? be + 1 : text.length]);
  }

  // The bare-bracket pattern ends in a lookahead: the `{` sits at `end`.
  for (const [start, end] of collectSpans(text, RE_BARE_BRACKET)) pushBrace(start, end);

  return regions;
}

/** G4 — is `pos` strictly inside a marker that opens before it? */
function coveredAt(pos: number, regions: Span[]): boolean {
  for (const [s, e] of regions) {
    if (s < pos && pos < e) return true;
  }
  return false;
}

// ─── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse all tool-call markup from a text string. Returns OpenAI-shape tool
 * calls with `id`, `name`, `arguments` (JSON string). `enabledToolNames`, when
 * given, is the promotion allowlist: a call whose name is not in the set is
 * not promoted (mirrors the Python allowlist gate).
 *
 * `idPrefix` namespaces the generated ids (`${idPrefix}_0`, `_1`, ...). The
 * default `"call"` keeps standalone parsing stable; the stream hook passes a
 * per-stream unique prefix so ids stay unique across every text block of one
 * message and can never collide with native tool-call ids.
 */
export function parseToolCallsFromText(
  text: string,
  enabledToolNames?: Set<string>,
  idPrefix = "call",
): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const tSpans = thinkSpans(text);
  const cSpans = codeSpanSpans(text);
  const tmSpans = tagMentionSpans(text);
  const regions = buildMarkerCoverage(text);

  // Track already-promoted spans to avoid double-parsing.
  const covered: Span[] = [];
  const isCovered = (start: number, end: number): boolean =>
    covered.some(([s, e]) => start < e && end > s);

  const addCall = (
    name: string,
    argsObj: Record<string, unknown> | string,
    start: number,
    end: number,
  ): void => {
    if (isCovered(start, end)) return;
    if (!name) return;
    if (enabledToolNames && !enabledToolNames.has(name)) return;
    covered.push([start, end]);
    const argsStr = typeof argsObj === "string" ? argsObj : JSON.stringify(argsObj);
    calls.push({ id: `${idPrefix}_${calls.length}`, name, arguments: argsStr, span: [start, end] });
  };

  // 1. <tool_call>{json}</tool_call> — one call per glued {...} body. Every sibling
  // body is promoted on its own; only the final body extends to the closing tag.
  RE_JSON_TOOL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_JSON_TOOL.exec(text)) !== null) {
    const openBrace = m.index + m[0].length - 1;
    if (inSpan(openBrace, tSpans)) continue; // G1
    if (inSpan(m.index, cSpans)) continue; // G2
    if (coveredAt(m.index, regions)) continue; // G4
    let cursor = openBrace;
    let bodyStart = m.index;
    for (;;) {
      const parsed = tryParseJsonAt(text, cursor);
      if (!parsed) break;
      const { obj, end } = parsed;
      const name = String(
        (obj["name"] as string | undefined) ??
          (obj["tool"] as string | undefined) ??
          ((obj["function"] as Record<string, unknown> | undefined)?.["name"] as string | undefined) ??
          "",
      );
      const args: Record<string, unknown> | string =
        (obj["arguments"] as Record<string, unknown> | string | undefined) ??
        (obj["parameters"] as Record<string, unknown> | string | undefined) ??
        (obj["args"] as Record<string, unknown> | string | undefined) ??
        {};
      // Another {...} body glued right after this one?
      const after = text.slice(end);
      const nextBody = /^\s*(\{)/.exec(after);
      if (nextBody && nextBody[1]) {
        // Glued sibling: emit this call over its own body, then continue with
        // the next one so no call is lost to span tiling.
        addCall(name, args, bodyStart, end);
        bodyStart = end;
        cursor = end + nextBody[0].length - 1;
        continue;
      }
      // Final body: extend the span to the closing tag.
      let fullEnd = end;
      const closeMatch = /^\s*(?:<\/tool_call>|<\|end_message\|>)/.exec(after);
      if (closeMatch) fullEnd = end + closeMatch[0].length;
      addCall(name, args, bodyStart, fullEnd);
      break;
    }
  }

  // 2. <|tool_call>call : name{json}<tool_call|>
  RE_GEMMA_TOOL.lastIndex = 0;
  while ((m = RE_GEMMA_TOOL.exec(text)) !== null) {
    const openBrace = m.index + m[0].length - 1;
    if (inSpan(openBrace, tSpans)) continue; // G1
    if (inSpan(m.index, cSpans)) continue; // G2
    if (coveredAt(m.index, regions)) continue; // G4
    const parsed = tryParseJsonAt(text, openBrace);
    if (!parsed) continue;
    let fullEnd = parsed.end;
    const closeMatch = /^\s*<tool_call\|>/.exec(text.slice(parsed.end));
    if (closeMatch) fullEnd = parsed.end + closeMatch[0].length;
    addCall(m[1] ?? "", parsed.obj, m.index, fullEnd);
  }

  // 2b. <minimax:tool_call>name{json}</minimax:tool_call>
  RE_MINIMAX_TOOL.lastIndex = 0;
  while ((m = RE_MINIMAX_TOOL.exec(text)) !== null) {
    const openBrace = m.index + m[0].length - 1;
    if (inSpan(openBrace, tSpans)) continue; // G1
    if (inSpan(m.index, cSpans)) continue; // G2
    if (coveredAt(m.index, regions)) continue; // G4
    const parsed = tryParseJsonAt(text, openBrace);
    if (!parsed) continue;
    let fullEnd = parsed.end;
    const closeMatch = /^\s*<\/minimax:tool_call>/.exec(text.slice(parsed.end));
    if (closeMatch) fullEnd = parsed.end + closeMatch[0].length;
    addCall(m[1] ?? "", parsed.obj, m.index, fullEnd);
  }

  // 3. <function=name>...</function> (param-tag format)
  RE_FUNC_TOOL.lastIndex = 0;
  while ((m = RE_FUNC_TOOL.exec(text)) !== null) {
    const funcStart = m.index;
    if (inSpan(funcStart, tSpans)) continue; // G1
    if (inSpan(funcStart, cSpans)) continue; // G2
    if (inSpan(funcStart, tmSpans)) continue; // G3
    if (coveredAt(funcStart, regions)) continue; // G4
    const closeIdx = text.indexOf("</function>", m.index + m[0].length);
    if (closeIdx < 0) continue;
    const fullEnd = closeIdx + "</function>".length;
    const body = text.slice(m.index + m[0].length, closeIdx);
    // Extract <parameter=key>value</parameter> pairs.
    const args: Record<string, unknown> = {};
    RE_PARAM.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = RE_PARAM.exec(body)) !== null) {
      const key = pm[1] ?? "";
      const raw = pm[2] ?? "";
      const trimmed = raw.trim();
      let val: unknown = raw;
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          val = JSON.parse(trimmed);
        } catch {
          // Keep as string.
        }
      }
      args[key] = val;
    }
    addCall(m[1] ?? "", args, funcStart, fullEnd);
  }

  // 4. [TOOL_CALLS][{json}, ...] (Mistral array; comma-less tolerated)
  RE_MISTRAL_ARRAY.lastIndex = 0;
  while ((m = RE_MISTRAL_ARRAY.exec(text)) !== null) {
    const arrStart = m.index + m[0].length;
    if (inSpan(m.index, tSpans)) continue; // G1
    if (inSpan(m.index, cSpans)) continue; // G2
    if (inSpan(m.index, tmSpans)) continue; // G3
    if (coveredAt(m.index, regions)) continue; // G4
    if (text[arrStart] !== "[") continue;
    const arrEnd = balancedBracketEnd(text, arrStart, true);
    if (arrEnd < 0) continue;
    const { items, ends } = decodeArrayItems(text, arrStart, arrEnd);
    if (items.length === 0) continue;
    items.forEach((item, idx) => {
      if (typeof item !== "object" || item === null) return;
      const it = item as Record<string, unknown>;
      const fnName = String(
        it["name"] ??
          ((it["function"] as Record<string, unknown> | undefined)?.["name"]) ??
          "",
      );
      let fnArgs: unknown =
        it["arguments"] ??
        (it["function"] as Record<string, unknown> | undefined)?.["arguments"] ??
        {};
      if (typeof fnArgs === "string") {
        // `arguments` may itself be a JSON string (OpenAI spec).
        try {
          fnArgs = JSON.parse(fnArgs);
        } catch {
          // Keep as raw string.
        }
      }
      if (typeof fnArgs !== "object" || fnArgs === null) fnArgs = {};
      // Tile spans so each byte belongs to exactly one promoted call.
      const itemStart = idx === 0 ? arrStart : ends[idx - 1]!;
      const itemEnd = ends[idx] ?? arrEnd + 1;
      addCall(fnName, fnArgs as Record<string, unknown> | string, itemStart, itemEnd);
    });
  }

  // 5. name[ARGS]{json} (bare rehearsal)
  RE_BARE_BRACKET.lastIndex = 0;
  while ((m = RE_BARE_BRACKET.exec(text)) !== null) {
    const openBrace = m.index + m[0].length;
    if (isExecutionClassName(m[1] ?? "")) continue; // G5
    if (inSpan(openBrace, tSpans)) continue; // G1
    if (inSpan(m.index, cSpans)) continue; // G2
    if (coveredAt(m.index, regions)) continue; // G4
    const parsed = tryParseJsonAt(text, openBrace);
    if (!parsed) continue;
    addCall(m[1] ?? "", parsed.obj, m.index, parsed.end);
  }

  return calls;
}

// ─── Markup stripping ───────────────────────────────────────────────────────

/**
 * Remove all tool-call markup from text, keeping only the prose. Think blocks
 * are preserved verbatim; a marker that was not promoted (e.g. quoted syntax)
 * stays in place.
 */
export function stripToolCallMarkup(
  text: string,
  enabledToolNames?: Set<string>,
): string {
  const calls = parseToolCallsFromText(text, enabledToolNames);
  if (calls.length === 0) return text;

  // Sort by start position, remove from end to start to preserve indices.
  const sorted = [...calls].sort((a, b) => a.span[0] - b.span[0]);
  let result = text;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const [s, e] = sorted[i]!.span;
    result = result.slice(0, s) + result.slice(e);
  }
  return result;
}

/** One text block's worth of response-side healing. */
export interface HealedTextBlock {
  /** The block text with promoted markup stripped. */
  text: string;
  /** Promoted calls in source order, ready for tool-call emission. */
  calls: ParsedToolCall[];
}

/**
 * Apply the response-side healing transform to one complete text block — the
 * exact pipeline the `llm/stream` hook runs at block-end: signal pre-filter,
 * parse with the promotion allowlist, strip promoted markup from the prose.
 * Returns null when the block is healthy (no signal, or no promotable call) so
 * callers pass it through byte-for-byte.
 */
export function healTextBlock(
  text: string,
  enabledToolNames?: Set<string>,
  idPrefix = "call",
  idStart = 0,
): HealedTextBlock | null {
  if (!hasHealSignal(text)) return null;
  const calls = parseToolCallsFromText(text, enabledToolNames, idPrefix);
  if (calls.length === 0) return null;
  // Renumber from `idStart` so a per-stream caller keeps ids unique across
  // every text block of one message — each block's own parse starts at zero.
  const numbered = calls.map((c, i) => ({ ...c, id: `${idPrefix}_${idStart + i}` }));
  return { text: stripToolCallMarkup(text, enabledToolNames), calls: numbered };
}

// ─── Gate (from passthrough_healing.py) ─────────────────────────────────────

/** Options `healGate` understands. Mirrors passthrough_healing.heal_gate. */
export interface HealGateOptions {
  tools?: Array<unknown>;
  response_format?: unknown;
  tool_choice?: unknown;
}

/**
 * Does `response_format` constrain decoding? Anything other than null /
 * `{"type":"text"}` forces the output into a structured shape, so healing a
 * free-text stream is off (matches the Python gate exactly).
 */
function responseFormatConstrainsDecoding(rf: unknown): boolean {
  if (rf == null) return false;
  if (typeof rf !== "object") return true;
  return (rf as Record<string, unknown>).type !== "text";
}

/** Extract a tool name from either `{name}` or `{function:{name}}`. */
function toolNameOf(t: unknown): string | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (typeof o.name === "string") return o.name;
  const f = o.function;
  if (f && typeof f === "object") {
    const fn = (f as Record<string, unknown>).name;
    if (typeof fn === "string") return fn;
  }
  return null;
}

/**
 * Determine whether healing should be active for this response, and return the
 * promotion allowlist (declared tool names) when it is. Returns null to disable.
 *
 * Healing is OFF when:
 *   - `tool_choice === "none"`, OR
 *   - `response_format` constrains decoding (not null / `{"type":"text"}`), OR
 *   - no declared tool survives a forced `tool_choice.function.name` filter.
 *
 * Accepts a `HealGateOptions` object or, for back-compat, a bare tools array.
 */
export function healGate(
  opts: HealGateOptions | Array<unknown> | undefined,
): Set<string> | null {
  const o: HealGateOptions = Array.isArray(opts) ? { tools: opts } : (opts ?? {});
  if (o.tool_choice === "none") return null;
  if (responseFormatConstrainsDecoding(o.response_format)) return null;

  const names = new Set<string>();
  for (const t of o.tools ?? []) {
    const n = toolNameOf(t);
    if (n) names.add(n);
  }

  // Forced single tool: intersect the allowlist with it.
  if (typeof o.tool_choice === "object" && o.tool_choice !== null) {
    const tc = o.tool_choice as Record<string, unknown>;
    const f = tc.function;
    if (f && typeof f === "object") {
      const forced = (f as Record<string, unknown>).name;
      if (typeof forced === "string") {
        for (const n of [...names]) if (n !== forced) names.delete(n);
        if (!names.has(forced)) return null;
      }
    }
  }

  return names.size > 0 ? names : null;
}
