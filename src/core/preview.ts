/**
 * Bounded, redacted argument previews used by diagnostic records and the
 * dashboard.
 *
 * Keeping both beginning and end makes appended top-level fields visible
 * without storing full code payloads in every event. Previews are NOT raw
 * copies: sensitive values (passwords, tokens, keys) are masked before they
 * reach the JSONL history or the panel, because a 180-character limit is not
 * redaction — bash commands, paths, and secrets would otherwise persist as-is.
 *
 * @module dsh-tool-doctor/core/preview
 */

const PREVIEW_LIMIT = 180;
const ELLIPSIS = " … ";
const REDACTED = "[redacted]";

/** One `"key": "value"` JSON pair (string values only). */
const JSON_STRING_PAIR_RE = /("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*")/g;

/** Key segments that mark a value as sensitive, compared after lowercasing. */
const SECRET_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "pass",
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "authorization",
  "auth",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "privatekey",
  "sessionid",
]);

/** Does a decoded JSON key name look sensitive? Segment-based, so `client_secret` and `db_password` match. */
function isSecretKey(keyJson: string): boolean {
  let key: unknown;
  try {
    key = JSON.parse(keyJson);
  } catch {
    return false; // Not a decodable key literal — leave the pair untouched.
  }
  if (typeof key !== "string") return false;
  const segments = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return segments.some((seg) => SECRET_KEY_SEGMENTS.has(seg));
}

/** `Authorization: Bearer <token>` style headers in serialized text. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g;

/** Well-known secret prefixes (OpenAI/Anthropic-style keys, GitHub, Slack, AWS, Google). */
const SECRET_PREFIX_RE = new RegExp(
  String.raw`\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b`,
  "g",
);

/** `scheme://user:password@host` — mask the password half only. */
const URL_USERINFO_RE = /(\w+:\/\/[^:@/\s]+:)([^@\s/]+)(@)/g;

/**
 * Mask sensitive values in a serialized argument preview. Deterministic and
 * conservative: it rewrites key-named fields, bearer tokens, well-known secret
 * prefixes, and URL passwords — nothing else moves, so paths and commands stay
 * readable for diagnosis.
 */
export function redactSensitive(text: string): string {
  if (text.length === 0) return text;
  let out = text.replace(
    JSON_STRING_PAIR_RE,
    (pair, keyJson: string, sep: string, _valueJson: string) =>
      isSecretKey(keyJson) ? `${keyJson}${sep}"${REDACTED}"` : pair,
  );
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(SECRET_PREFIX_RE, REDACTED);
  out = out.replace(
    URL_USERINFO_RE,
    (_m, pre: string, _pw: string, post: string) => `${pre}${REDACTED}${post}`,
  );
  return out;
}

/**
 * Keep a bounded preview while retaining both ends of the serialized value.
 * Sensitive values are redacted before truncation so neither the JSONL history
 * nor the dashboard ever carries raw secrets.
 * @param text - Serialized arguments or diagnostic text.
 * @param limit - Maximum returned character count.
 * @returns A complete string or a head/tail preview with an omission marker.
 */
export function compactPreview(text: string, limit = PREVIEW_LIMIT): string {
  const safe = redactSensitive(text);
  if (safe.length <= limit) return safe;
  if (limit <= ELLIPSIS.length) return safe.slice(0, Math.max(0, limit));

  const available = limit - ELLIPSIS.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${safe.slice(0, headLength)}${ELLIPSIS}${safe.slice(-tailLength)}`;
}
