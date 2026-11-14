/**
 * Shared JavaScript lexical scanner for program-body repairs.
 *
 * Both syntax repair and inner-call description injection must reason about
 * where strings, templates (including `${...}` code), comments, regex
 * literals and structural brackets live — so the scanning primitives live in
 * one place instead of being duplicated per mechanic. Every consumer treats a
 * scanner result as "trustworthy or not": an unterminated construct is either
 * itself a repair candidate (syntax) or grounds to abort safely (injection).
 *
 * @module dsh-tool-doctor/repair/lexer
 */

const BACKTICK = String.fromCharCode(96);
const SINGLE_QUOTE = String.fromCharCode(39);
const DOUBLE_QUOTE = String.fromCharCode(34);
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;

/** One lexical scan boundary: the end offset of a construct, or why it never ended. */
export type Scan =
  | { end: number }
  | { unterminated: "string" | "template" | "regex" | "comment" };

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && IDENTIFIER_START.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENTIFIER_PART.test(ch);
}

/** End of the line comment opened at start (the newline, or EOF). */
export function skipLineComment(code: string, start: number): number {
  const newline = code.indexOf("\n", start + 2);
  return newline === -1 ? code.length : newline;
}

/** End of the block comment opened at start, or -1 when unterminated. */
export function skipBlockComment(code: string, start: number): number {
  const end = code.indexOf("*/", start + 2);
  return end === -1 ? -1 : end + 2;
}

/** Whether a slash at start is syntactically likely to open a regex literal. */
export function isRegexStart(code: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i--;
  if (i < 0) return true;
  const previous = code[i]!;
  if ("([{,:;=!?&|+-*%^~<>".includes(previous)) return true;
  if (isIdentifierPart(previous)) {
    let wordStart = i;
    while (wordStart >= 0 && isIdentifierPart(code[wordStart])) wordStart--;
    const word = code.slice(wordStart + 1, i + 1);
    return new Set([
      "return",
      "throw",
      "case",
      "delete",
      "void",
      "typeof",
      "new",
      "in",
      "of",
      "yield",
      "await",
      "else",
      "do",
    ]).has(word);
  }
  return false;
}

/** Skip one regular-expression literal including its flags. */
export function skipRegex(code: string, start: number): Scan {
  let inClass = false;
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n" || ch === "\r") return { unterminated: "regex" };
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      i++;
      while (i < code.length && /[A-Za-z]/.test(code[i]!)) i++;
      return { end: i };
    }
    i++;
  }
  return { unterminated: "regex" };
}

/** Skip the expression body of one template interpolation; -1 when unterminated. */
export function skipTemplateExpression(code: string, start: number): number {
  let depth = 1;
  let i = start;
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
    else if (ch === "}" && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/** Skip one quoted or template string, recursively walking `${...}` code. */
export function skipStringOrTemplate(code: string, start: number): Scan {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote !== BACKTICK) {
      if (ch === quote) return { end: i + 1 };
      i++;
      continue;
    }
    if (ch === BACKTICK) return { end: i + 1 };
    if (ch === "$" && code[i + 1] === "{") {
      const end = skipTemplateExpression(code, i + 2);
      if (end < 0) return { unterminated: "template" };
      i = end;
      continue;
    }
    i++;
  }
  return { unterminated: quote === BACKTICK ? "template" : "string" };
}

/**
 * Walk the program outside strings, templates, comments and regex literals.
 * The callback sees every structural character (and a `"\0"` marker at an
 * unterminated string/template position); returning an offset stops the walk
 * there. An undefined return means the walker hit a construct it cannot trust
 * (unterminated block comment or regex) — callers must treat that as "no
 * conclusion", never as "nothing found".
 */
export function walkStructure(
  code: string,
  at: (char: string, index: number) => number | undefined,
): { stoppedAt: number } | undefined {
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === SINGLE_QUOTE || ch === DOUBLE_QUOTE || ch === BACKTICK) {
      const end = skipStringOrTemplate(code, i);
      if (!("end" in end)) {
        // An unterminated string/template is itself a repair candidate, not a
        // reason to distrust the walk: report its position and let the
        // callback decide.
        const stopped = at("\0", i);
        return { stoppedAt: stopped ?? i };
      }
      i = end.end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i = skipLineComment(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = skipBlockComment(code, i);
      if (end < 0) return undefined;
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
      if (!("end" in end)) return undefined;
      i = end.end;
      continue;
    }
    const stopped = at(ch, i);
    if (stopped !== undefined) return { stoppedAt: stopped };
    i++;
  }
  return { stoppedAt: code.length };
}

/** Whether a backtick at index is preceded by an odd run of backslashes. */
export function isEscapedBacktick(code: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && code[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

export const LEXER = { BACKTICK, SINGLE_QUOTE, DOUBLE_QUOTE };
