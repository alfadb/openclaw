import { describe, expect, it } from "vitest";
import { classifyRecoverableToolError } from "./recoverable-tool-errors.js";

describe("classifyRecoverableToolError", () => {
  it("detects edit exact match not found and extracts path", () => {
    const out = classifyRecoverableToolError({
      toolName: "edit",
      error:
        "Could not find the exact text in /home/user/file.md. The old text must match exactly including all whitespace and newlines.",
    });
    expect(out).toMatchObject({
      kind: "EDIT_EXACT_MATCH_NOT_FOUND",
      toolName: "edit",
      path: "/home/user/file.md",
    });
  });

  it("detects edit not unique and extracts path", () => {
    const out = classifyRecoverableToolError({
      toolName: "edit",
      error:
        "Found 19 occurrences of the text in /home/user/file.md. The text must be unique. Please provide more context to make it unique.",
    });
    expect(out).toMatchObject({
      kind: "EDIT_NOT_UNIQUE",
      toolName: "edit",
      path: "/home/user/file.md",
    });
  });

  it("returns null for other tool errors", () => {
    expect(classifyRecoverableToolError({ toolName: "read", error: "missing path" })).toBeNull();
  });
});
