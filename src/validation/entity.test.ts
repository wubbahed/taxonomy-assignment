import { describe, expect, it } from "vitest";
import type { AttributeValue, Taxonomy } from "../shared/index.js";
import { AppError } from "../errors.js";
import { normalizeAttributes, validateAttributes } from "./entity.js";

const taxonomy: Taxonomy = {
  id: "widgets",
  name: "Widgets",
  archived: false,
  fields: [
    { key: "sku", type: "string", required: true, is_key: true },
    { key: "count", type: "integer", required: true, is_key: false },
    { key: "on_sale", type: "boolean", required: false, is_key: false },
    { key: "released_on", type: "date", required: false, is_key: false },
  ],
  relationships: [],
};

function expectError(fn: () => void): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected validation error");
}

describe("validateAttributes", () => {
  it("accepts a complete valid attribute set", () => {
    expect(() =>
      validateAttributes(
        taxonomy,
        { sku: "A", count: 1, on_sale: true, released_on: "2026-04-20" },
        { requireAll: true },
      ),
    ).not.toThrow();
  });

  it("rejects unknown attribute keys", () => {
    const err = expectError(() =>
      validateAttributes(
        taxonomy,
        { sku: "A", count: 1, extra: "nope" },
        { requireAll: true },
      ),
    );
    expect(JSON.stringify(err.details)).toContain("extra");
  });

  it("rejects missing required fields when requireAll is true", () => {
    const err = expectError(() =>
      validateAttributes(taxonomy, { sku: "A" }, { requireAll: true }),
    );
    const fields = (err.details as { fields: Record<string, string> }).fields;
    expect(fields.count).toBeDefined();
  });

  it("does not require all fields when requireAll is false (PATCH semantics)", () => {
    expect(() =>
      validateAttributes(taxonomy, { count: 10 }, { requireAll: false }),
    ).not.toThrow();
  });

  it("rejects null on a required field", () => {
    const err = expectError(() =>
      validateAttributes(
        taxonomy,
        { sku: null, count: 1 },
        { requireAll: false },
      ),
    );
    const fields = (err.details as { fields: Record<string, string> }).fields;
    expect(fields.sku).toMatch(/required/);
  });

  it("allows null on optional fields", () => {
    expect(() =>
      validateAttributes(
        taxonomy,
        { on_sale: null, released_on: null },
        { requireAll: false },
      ),
    ).not.toThrow();
  });

  it("rejects nested objects and arrays for every field", () => {
    const err = expectError(() =>
      validateAttributes(
        taxonomy,
        { sku: { nested: "no" }, count: [1, 2] } as never,
        { requireAll: false },
      ),
    );
    const fields = (err.details as { fields: Record<string, string> }).fields;
    expect(fields.sku).toBeDefined();
    expect(fields.count).toBeDefined();
  });

  it("rejects type mismatches per field", () => {
    const err = expectError(() =>
      validateAttributes(
        taxonomy,
        {
          sku: 1,
          count: "two",
          on_sale: "yes",
          released_on: "not-a-date",
        } as never,
        { requireAll: false },
      ),
    );
    const fields = (err.details as { fields: Record<string, string> }).fields;
    expect(Object.keys(fields)).toEqual(
      expect.arrayContaining(["sku", "count", "on_sale", "released_on"]),
    );
  });

  it("aggregates multiple issues in one error", () => {
    const err = expectError(() =>
      validateAttributes(taxonomy, { sku: 1, count: "two" } as never, {
        requireAll: false,
      }),
    );
    const fields = (err.details as { fields: Record<string, string> }).fields;
    expect(Object.keys(fields).length).toBeGreaterThanOrEqual(2);
  });
});

describe("normalizeAttributes — Unicode NFC", () => {
  // `café` in NFD form: e + U+0301 (combining acute accent).
  const cafeNFD = "cafe\u0301";
  // `café` in NFC form: U+00E9 (precomposed).
  const cafeNFC = "caf\u00e9";

  it("rewrites NFD-encoded strings as NFC in place", () => {
    const attrs: Record<string, AttributeValue> = { name: cafeNFD };
    expect(attrs.name).not.toBe(cafeNFC); // sanity: starts as NFD
    normalizeAttributes(attrs);
    expect(attrs.name).toBe(cafeNFC);
  });

  it("is idempotent on already-NFC strings", () => {
    const attrs: Record<string, AttributeValue> = { name: cafeNFC };
    normalizeAttributes(attrs);
    expect(attrs.name).toBe(cafeNFC);
  });

  it("leaves non-string values untouched", () => {
    const attrs: Record<string, AttributeValue> = {
      count: 42,
      active: true,
      nickname: null,
      label: cafeNFD,
    };
    normalizeAttributes(attrs);
    expect(attrs.count).toBe(42);
    expect(attrs.active).toBe(true);
    expect(attrs.nickname).toBeNull();
    expect(attrs.label).toBe(cafeNFC);
  });

  it("handles Chinese, Japanese, Arabic, and emoji as-is (already canonical)", () => {
    const attrs: Record<string, AttributeValue> = {
      chinese: "山田太郎",
      japanese: "こんにちは",
      arabic: "مرحبا",
      emoji: "🎉👨‍👩‍👧‍👦",
    };
    const before = { ...attrs };
    normalizeAttributes(attrs);
    expect(attrs).toEqual(before);
  });

  it("canonicalizes NFD variants of CJK compatibility characters", () => {
    // U+FA0C is a CJK compatibility character that normalizes to U+5140.
    // This is a real-world case where normalization actually changes CJK text.
    const compatibility = "\uFA0C";
    const canonical = "\u5140";
    const attrs: Record<string, AttributeValue> = { name: compatibility };
    normalizeAttributes(attrs);
    expect(attrs.name).toBe(canonical);
  });

  it("lets NFC and NFD-encoded 'same' strings match after normalization", () => {
    // Simulates two writes from clients using different encodings —
    // they should round-trip to byte-identical stored values.
    const writeA: Record<string, AttributeValue> = { city: cafeNFD };
    const writeB: Record<string, AttributeValue> = { city: cafeNFC };
    normalizeAttributes(writeA);
    normalizeAttributes(writeB);
    expect(writeA.city).toBe(writeB.city);
  });
});
