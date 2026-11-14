/**
 * Diagnostic-preview redaction tests. Redaction is the only thing standing
 * between a raw tool argument and the JSONL history / dashboard, so both the
 * false negatives (a leaked secret) and the false positives (a mangled
 * command) matter.
 */
import { describe, expect, it } from "vitest";
import { compactPreview, redactSensitive } from "../src/core/preview.ts";

describe("redactSensitive — JSON key-named values", () => {
  it("masks string values under sensitive keys", () => {
    expect(redactSensitive('{"password":"hunter2","user":"amy"}')).toBe(
      '{"password":"[redacted]","user":"amy"}',
    );
  });

  it("masks NUMBER values under sensitive keys (a numeric PIN is a secret)", () => {
    // Reviewer case: the old strings-only regex leaked {"password":12345678}.
    expect(redactSensitive('{"password":12345678}')).toBe('{"password":"[redacted]"}');
    expect(redactSensitive('{"apiKey":9.5}')).toBe('{"apiKey":"[redacted]"}');
    expect(redactSensitive('{"token":true}')).toBe('{"token":"[redacted]"}');
  });

  it("leaves null values alone (no secret to hide)", () => {
    expect(redactSensitive('{"token":null}')).toBe('{"token":null}');
  });

  it("matches compound key names by segment", () => {
    expect(redactSensitive('{"client_secret":"abc123","db_password":"p","monkey":7}')).toBe(
      '{"client_secret":"[redacted]","db_password":"[redacted]","monkey":7}',
    );
  });

  it("does not redact non-sensitive pairs and keeps ordinary JSON intact", () => {
    const text = '{"path":"C:\\\\proj\\\\src","count":12345678,"names":["a","b"]}';
    expect(redactSensitive(text)).toBe(text);
  });
});

describe("redactSensitive — text-shaped secrets", () => {
  it("masks bearer tokens and known prefixes", () => {
    expect(redactSensitive("Authorization: Bearer abc.def_ghi-jkl==")).toContain("[redacted]");
    expect(redactSensitive("use sk-abcdefghijklmnopqrstuvwxyz now")).toContain("[redacted]");
  });

  it("masks only the password half of a URL with userinfo", () => {
    expect(redactSensitive("postgres://svc:s3cr3t@db.internal:5432/app")).toBe(
      "postgres://svc:[redacted]@db.internal:5432/app",
    );
  });

  it("masks sensitive command-flag values but leaves ordinary flags", () => {
    expect(redactSensitive("mysql --user svc --password p@ss1 --port 3306")).toBe(
      "mysql --user svc --password [redacted] --port 3306",
    );
  });
});

describe("compactPreview", () => {
  it("returns short text unchanged", () => {
    expect(compactPreview("hello", 180)).toBe("hello");
  });

  it("keeps head and tail around an omission marker, redacting first", () => {
    const long = `{"password":"sup3rsecret","filler":"${"x".repeat(400)}"}`;
    const out = compactPreview(long, 80);
    expect(out).toContain(" … ");
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).not.toContain("sup3rsecret");
  });
});
