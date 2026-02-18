import { describe, expect, it } from "vitest";
import { formatInlineJsonAfterPrefix, sanitizeForFeishu, softWrapLongTokens } from "./sanitize.js";

describe("feishu sanitize", () => {
  it("softWrapLongTokens wraps long unbroken tokens", () => {
    const token = "a".repeat(260);
    const out = softWrapLongTokens(`prefix ${token} suffix`, { tokenLimit: 200, wrapAt: 120 });
    expect(out).toContain("prefix ");
    expect(out).toContain(" suffix");
    // Should insert a newline in the long token
    expect(out).toContain("\n");
  });

  it("formatInlineJsonAfterPrefix pretty prints JSON after prefix", () => {
    const line =
      'feishu: fetched quoted message: {"title":"","content":[[{"tag":"text","text":"hi"}]]}';
    const out = formatInlineJsonAfterPrefix(line, "fetched quoted message:");
    expect(out).toContain("```json");
    expect(out).toContain('\n  "title": ""');
  });

  it("sanitizeForFeishu keeps normal text unchanged (no long tokens)", () => {
    const text = "hello world\n- a\n- b";
    expect(sanitizeForFeishu(text)).toBe(text);
  });
});
