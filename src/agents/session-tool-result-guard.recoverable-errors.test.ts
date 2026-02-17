import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

describe("installSessionToolResultGuard (recoverable tool errors)", () => {
  it("annotates edit exact-match tool errors with a recoverable hint", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "edit", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "edit",
        isError: true,
        content: [
          {
            type: "text",
            text: "⚠️ Edit failed: Could not find the exact text in /tmp/example.md. The old text must match exactly including all whitespace and newlines.",
          },
        ],
      }),
    );

    const messages = getPersistedMessages(sm);
    const toolResult = messages.find((m) => m.role === "toolResult") as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(toolResult).toBeDefined();

    const allText = toolResult.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");

    expect(allText).toContain("[RECOVERABLE_TOOL_ERROR]");
    expect(allText).toContain("EDIT_EXACT_MATCH_NOT_FOUND");
    expect(allText).toContain("/tmp/example.md");
  });
});
