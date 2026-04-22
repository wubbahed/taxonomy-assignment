import { describe, it, expect } from "vitest";
import { checkValueType } from "./valueTypes.js";

describe("checkValueType", () => {
  it("accepts null for any type", () => {
    for (const t of [
      "string",
      "integer",
      "float",
      "boolean",
      "date",
      "datetime",
    ] as const) {
      expect(checkValueType(t, null).ok).toBe(true);
    }
  });

  it("rejects objects and arrays for every type", () => {
    const nonScalars: unknown[] = [{}, { nested: 1 }, [], [1, 2], new Date()];
    for (const value of nonScalars) {
      expect(checkValueType("string", value).ok).toBe(false);
      expect(checkValueType("integer", value).ok).toBe(false);
      expect(checkValueType("boolean", value).ok).toBe(false);
    }
  });

  it("enforces integer vs float", () => {
    expect(checkValueType("integer", 5).ok).toBe(true);
    expect(checkValueType("integer", 5.1).ok).toBe(false);
    expect(checkValueType("float", 5.1).ok).toBe(true);
    expect(checkValueType("float", Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("enforces date and datetime formats", () => {
    expect(checkValueType("date", "2026-04-20").ok).toBe(true);
    expect(checkValueType("date", "04/20/2026").ok).toBe(false);
    expect(checkValueType("datetime", "2026-04-20T12:00:00Z").ok).toBe(true);
    expect(checkValueType("datetime", "not-a-datetime").ok).toBe(false);
  });

  it("rejects NaN for numeric types", () => {
    expect(checkValueType("integer", Number.NaN).ok).toBe(false);
    expect(checkValueType("float", Number.NaN).ok).toBe(false);
  });

  it("accepts negative and zero integers", () => {
    expect(checkValueType("integer", 0).ok).toBe(true);
    expect(checkValueType("integer", -1).ok).toBe(true);
    expect(checkValueType("integer", -9999).ok).toBe(true);
  });

  it("treats the empty string as a valid string", () => {
    expect(checkValueType("string", "").ok).toBe(true);
  });

  it("does not treat 0/1 as booleans", () => {
    expect(checkValueType("boolean", 0).ok).toBe(false);
    expect(checkValueType("boolean", 1).ok).toBe(false);
  });

  it("rejects impossibly-formatted dates even if they pattern-match", () => {
    // Regex passes but Date.parse rejects 2026-13-01
    expect(checkValueType("date", "2026-13-01").ok).toBe(false);
  });

  it("rejects numeric strings for numeric types", () => {
    expect(checkValueType("integer", "42").ok).toBe(false);
    expect(checkValueType("float", "3.14").ok).toBe(false);
  });
});
