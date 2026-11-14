/**
 * Preemptive repair for Code-Mode inner-call schema failures.
 *
 * Some sub-dispatches inside run_code validate required `description` fields
 * before their tool body runs; a program that omits one fails before any later
 * listener can help. This pass recognizes only literal object arguments and
 * uses the shared lexical scanner so strings, templates, comments, regex
 * literals, nested objects, spreads and computed keys are never mistaken for
 * missing properties. A scan it cannot trust aborts with zero injections —
 * a wrong insertion costs more than the original failure.
 *
 * @module dsh-tool-doctor/repair/inner-description
 */

import {
  LEXER,
  isRegexStart,
  skipBlockComment,
  skipLineComment,
  skipRegex,
  skipStringOrTemplate,
} from "./lexer.ts";

const BACKTICK = LEXER.BACKTICK;
const SINGLE_QUOTE = LEXER.SINGLE_QUOTE;
const DOUBLE_QUOTE = LEXER.DOUBLE_QUOTE;
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && IDENTIFIER_START.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENTIFIER_PART.test(ch);
}

/** Index of the brace closing the object opened at open, or -1. */
function findObjectEnd(code: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
      const end = skipStringOrTemplate(code, i);
      if (!("end" in end)) return -1;
      i = end.end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i = skipLineComment(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = skipBlockComment(code, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (
      ch === "/" &&
      code[i + 1] !== "/" &&
      code[i + 1] !== "*" &&
      isRegexStart(code, i)
    ) {
      const end = skipRegex(code, i);
      if (!("end" in end)) return -1;
      i = end.end;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipWhitespace(code: string, start: number, end: number): number {
  let i = start;
  while (i < end && /\s/.test(code[i]!)) i++;
  return i;
}

/** Decode a quoted property key when the form is simple enough to trust. */
function quotedKey(
  code: string,
  start: number,
  end: number,
): { key: string | undefined; next: number } {
  const scanned = skipStringOrTemplate(code, start);
  if (!("end" in scanned) || scanned.end > end) return { key: undefined, next: -1 };
  const raw = code.slice(start, scanned.end);
  if (raw[0] === DOUBLE_QUOTE) {
    try {
      return { key: JSON.parse(raw) as string, next: scanned.end };
    } catch {
      return { key: undefined, next: scanned.end };
    }
  }
  // Single-quoted property names are uncommon here; only decode the simple
  // form so an escape cannot make the scanner claim certainty.
  return raw.endsWith(SINGLE_QUOTE) && raw.slice(1, -1).includes("\\")
    ? { key: undefined, next: scanned.end }
    : { key: raw.slice(1, -1), next: scanned.end };
}

/**
 * Whether an object literal already supplies or may supply `description`.
 * Spreads and computed keys are treated as present/unknown so the repair never
 * creates a duplicate property that changes semantics.
 */
function hasDescriptionProperty(
  code: string,
  open: number,
  close: number,
): boolean {
  let depth = 0;
  let expectProperty = true;
  let i = open + 1;
  while (i < close) {
    const ch = code[i];
    if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
      const scanned = skipStringOrTemplate(code, i);
      if (!("end" in scanned) || scanned.end > close) return true;
      if (depth === 0 && expectProperty) {
        const { key, next } = quotedKey(code, i, close);
        const after = skipWhitespace(code, next, close);
        if (key === "description") return true;
        expectProperty = code[after] === ":" ? false : true;
      }
      i = scanned.end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i = skipLineComment(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = skipBlockComment(code, i);
      if (end < 0) return true;
      i = end;
      continue;
    }
    if (
      ch === "/" &&
      code[i + 1] !== "/" &&
      code[i + 1] !== "*" &&
      isRegexStart(code, i)
    ) {
      const end = skipRegex(code, i);
      if (!("end" in end)) return true;
      i = end.end;
      continue;
    }
    if (depth === 0) {
      if (ch === ",") {
        expectProperty = true;
        i++;
        continue;
      }
      if (!expectProperty) {
        if (ch === "{" || ch === "[") depth++;
        i++;
        continue;
      }
      if (code.startsWith("...", i) || ch === "[") return true;
      if (isIdentifierStart(ch)) {
        let end = i + 1;
        while (end < close && isIdentifierPart(code[end])) end++;
        const key = code.slice(i, end);
        const after = skipWhitespace(code, end, close);
        if (key === "description") return true;
        if (code[after] === ":") expectProperty = false;
        else if (code[after] === "(") expectProperty = false;
        else expectProperty = true;
        i = end;
        continue;
      }
      if (ch === "}") return false;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    i++;
  }
  return false;
}

/** A `tools.<name>({` call opening an options object literal. */
const CALL_SHAPE = /^tools\.([A-Za-z_$][\w$]*)\s*\(\s*\{/u;

/** Schema-aware predicate: does this target tool require a description? */
export type DescriptionRequirement = (toolName: string) => boolean;

/**
 * Insert a generated description into each selected `tools.<name>({ ... })`
 * options object whose literal lacks one. String/template/comment contents are
 * never rewritten. Returns the rewritten program and insertion count;
 * injected: 0 means no change was needed or the scan could not be trusted.
 *
 * @param code - Code-Mode program source.
 * @param outerDescription - Description of the enclosing run_code call.
 * @param requiresDescription - Schema-aware predicate for the target tool.
 */
export function injectInnerDescriptions(
  code: string,
  outerDescription: string,
  requiresDescription: DescriptionRequirement = () => true,
): { code: string; injected: number } {
  // Fast path for the common healthy case: no inner dispatch, no scan.
  if (!code.includes("tools.")) return { code, injected: 0 };

  const out: string[] = [];
  let i = 0;
  let injected = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
      const scanned = skipStringOrTemplate(code, i);
      if (!("end" in scanned)) return { code, injected: 0 };
      out.push(code.slice(i, scanned.end));
      i = scanned.end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const end = skipLineComment(code, i);
      out.push(code.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = skipBlockComment(code, i);
      if (end < 0) return { code, injected: 0 };
      out.push(code.slice(i, end));
      i = end;
      continue;
    }
    if (
      ch === "/" &&
      code[i + 1] !== "/" &&
      code[i + 1] !== "*" &&
      isRegexStart(code, i)
    ) {
      const scanned = skipRegex(code, i);
      if (!("end" in scanned)) return { code, injected: 0 };
      out.push(code.slice(i, scanned.end));
      i = scanned.end;
      continue;
    }
    if (ch === "t" && code.startsWith("tools.", i)) {
      const match = CALL_SHAPE.exec(code.slice(i));
      if (match !== null) {
        const open = i + match[0].length - 1;
        const close = findObjectEnd(code, open);
        if (close < 0) return { code, injected: 0 };
        if (hasDescriptionProperty(code, open, close) || !requiresDescription(match[1]!)) {
          out.push(code.slice(i, close + 1));
        } else {
          const base = `${outerDescription || "inner call"} · ${match[1]}`;
          const label = base.slice(0, 80);
          out.push(code.slice(i, open + 1));
          out.push(` description: ${JSON.stringify(label)},`);
          out.push(code.slice(open + 1, close + 1));
          injected++;
        }
        i = close + 1;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return { code: out.join(""), injected };
}
