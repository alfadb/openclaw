import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
} from "../plugins/types.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { HARD_MAX_TOOL_RESULT_CHARS } from "./pi-embedded-runner/tool-result-truncation.js";
import { makeMissingToolResult, sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

const GUARD_TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated during persistence — original exceeded size limit. " +
  "Use offset/limit parameters or request specific sections for large content.]";

const RECOVERABLE_ERROR_HINT_PREFIX = "\n\n[RECOVERABLE_TOOL_ERROR]";

function getToolResultTextBlocks(msg: AgentMessage): TextContent[] {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is TextContent =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as TextContent).text === "string",
  );
}

function appendToolResultHint(msg: AgentMessage, hint: string): AgentMessage {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }
  return {
    ...msg,
    content: [...content, { type: "text", text: hint }],
  } as AgentMessage;
}

function annotateRecoverableToolErrors(
  msg: AgentMessage,
  meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
): AgentMessage {
  // Only annotate real tool results (not synthetic placeholders).
  if (meta.isSynthetic) {
    return msg;
  }
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }

  const toolName = (meta.toolName ?? (msg as { toolName?: string }).toolName ?? "")
    .trim()
    .toLowerCase();
  const isError = Boolean((msg as { isError?: boolean }).isError);
  if (!isError) {
    return msg;
  }

  // Avoid adding duplicate annotations if we already annotated this tool result.
  const existingText = getToolResultTextBlocks(msg)
    .map((b) => b.text)
    .join("\n");
  if (existingText.includes(RECOVERABLE_ERROR_HINT_PREFIX)) {
    return msg;
  }

  // v1: edit exact-match failure is recoverable by reading file + retry with shorter anchor.
  if (toolName === "edit") {
    const matchNotFound = /Could not find the exact text\b/i.test(existingText);
    if (matchNotFound) {
      const fileMatch = existingText.match(/Could not find the exact text in ([^\n.]+)\./i);
      const filePath = fileMatch?.[1]?.trim();
      const payload = {
        kind: "EDIT_EXACT_MATCH_NOT_FOUND",
        toolName: "edit",
        toolCallId: meta.toolCallId,
        path: filePath,
        suggestedRecovery: [
          "read(path) to fetch the current file content (head 100-200 lines)",
          "retry edit with a smaller/unique oldText anchor (e.g. only the header line)",
          "if still failing, rebuild the updated content and use write as fallback (ask first if risky)",
        ],
      };
      const hintLines = [
        RECOVERABLE_ERROR_HINT_PREFIX,
        "kind: EDIT_EXACT_MATCH_NOT_FOUND",
        filePath ? `path: ${filePath}` : undefined,
        "recovery_payload_json:",
        "```json",
        JSON.stringify(payload, null, 2),
        "```",
        "suggested_recovery:",
        "- call read(path) to fetch the current file content (head 100-200 lines)",
        "- retry edit with a smaller/unique oldText anchor (e.g. only the header line)",
        "- if still failing, rebuild the full updated content and use write as a fallback (ask first if risky)",
      ].filter(Boolean);
      return appendToolResultHint(msg, hintLines.join("\n"));
    }
  }

  return msg;
}

/**
 * Truncate oversized text content blocks in a tool result message.
 * Returns the original message if under the limit, or a new message with
 * truncated text blocks otherwise.
 */
function capToolResultSize(msg: AgentMessage): AgentMessage {
  const role = (msg as { role?: string }).role;
  if (role !== "toolResult") {
    return msg;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return msg;
  }

  // Calculate total text size
  let totalTextChars = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        totalTextChars += text.length;
      }
    }
  }

  if (totalTextChars <= HARD_MAX_TOOL_RESULT_CHARS) {
    return msg;
  }

  // Truncate proportionally
  const newContent = content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return block;
    }
    const textBlock = block as TextContent;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    const blockShare = textBlock.text.length / totalTextChars;
    const blockBudget = Math.max(
      2_000,
      Math.floor(HARD_MAX_TOOL_RESULT_CHARS * blockShare) - GUARD_TRUNCATION_SUFFIX.length,
    );
    if (textBlock.text.length <= blockBudget) {
      return block;
    }
    // Try to cut at a newline boundary
    let cutPoint = blockBudget;
    const lastNewline = textBlock.text.lastIndexOf("\n", blockBudget);
    if (lastNewline > blockBudget * 0.8) {
      cutPoint = lastNewline;
    }
    return {
      ...textBlock,
      text: textBlock.text.slice(0, cutPoint) + GUARD_TRUNCATION_SUFFIX,
    };
  });

  return { ...msg, content: newContent } as AgentMessage;
}

export function installSessionToolResultGuard(
  sessionManager: SessionManager,
  opts?: {
    /**
     * Optional transform applied to any message before persistence.
     */
    transformMessageForPersistence?: (message: AgentMessage) => AgentMessage;
    /**
     * Optional, synchronous transform applied to toolResult messages *before* they are
     * persisted to the session transcript.
     */
    transformToolResultForPersistence?: (
      message: AgentMessage,
      meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
    ) => AgentMessage;
    /**
     * Whether to synthesize missing tool results to satisfy strict providers.
     * Defaults to true.
     */
    allowSyntheticToolResults?: boolean;
    /**
     * Synchronous hook invoked before any message is written to the session JSONL.
     * If the hook returns { block: true }, the message is silently dropped.
     * If it returns { message }, the modified message is written instead.
     */
    beforeMessageWriteHook?: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | undefined;
  },
): {
  flushPendingToolResults: () => void;
  getPendingIds: () => string[];
} {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);
  const pending = new Map<string, string | undefined>();
  const persistMessage = (message: AgentMessage) => {
    const transformer = opts?.transformMessageForPersistence;
    return transformer ? transformer(message) : message;
  };

  const persistToolResult = (
    message: AgentMessage,
    meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean },
  ) => {
    const transformer = opts?.transformToolResultForPersistence;
    const transformed = transformer ? transformer(message, meta) : message;
    return annotateRecoverableToolErrors(transformed, meta);
  };

  const allowSyntheticToolResults = opts?.allowSyntheticToolResults ?? true;
  const beforeWrite = opts?.beforeMessageWriteHook;

  /**
   * Run the before_message_write hook. Returns the (possibly modified) message,
   * or null if the message should be blocked.
   */
  const applyBeforeWriteHook = (msg: AgentMessage): AgentMessage | null => {
    if (!beforeWrite) {
      return msg;
    }
    const result = beforeWrite({ message: msg });
    if (result?.block) {
      return null;
    }
    if (result?.message) {
      return result.message;
    }
    return msg;
  };

  const flushPendingToolResults = () => {
    if (pending.size === 0) {
      return;
    }
    if (allowSyntheticToolResults) {
      for (const [id, name] of pending.entries()) {
        const synthetic = makeMissingToolResult({ toolCallId: id, toolName: name });
        const flushed = applyBeforeWriteHook(
          persistToolResult(persistMessage(synthetic), {
            toolCallId: id,
            toolName: name,
            isSynthetic: true,
          }),
        );
        if (flushed) {
          originalAppend(flushed as never);
        }
      }
    }
    pending.clear();
  };

  const guardedAppend = (message: AgentMessage) => {
    let nextMessage = message;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const sanitized = sanitizeToolCallInputs([message]);
      if (sanitized.length === 0) {
        if (allowSyntheticToolResults && pending.size > 0) {
          flushPendingToolResults();
        }
        return undefined;
      }
      nextMessage = sanitized[0];
    }
    const nextRole = (nextMessage as { role?: unknown }).role;

    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage as Extract<AgentMessage, { role: "toolResult" }>);
      const toolName = id ? pending.get(id) : undefined;
      if (id) {
        pending.delete(id);
      }
      // Apply hard size cap before persistence to prevent oversized tool results
      // from consuming the entire context window on subsequent LLM calls.
      const capped = capToolResultSize(persistMessage(nextMessage));
      const persisted = applyBeforeWriteHook(
        persistToolResult(capped, {
          toolCallId: id ?? undefined,
          toolName,
          isSynthetic: false,
        }),
      );
      if (!persisted) {
        return undefined;
      }
      return originalAppend(persisted as never);
    }

    const toolCalls =
      nextRole === "assistant"
        ? extractToolCallsFromAssistant(nextMessage as Extract<AgentMessage, { role: "assistant" }>)
        : [];

    if (allowSyntheticToolResults) {
      // If previous tool calls are still pending, flush before non-tool results.
      if (pending.size > 0 && (toolCalls.length === 0 || nextRole !== "assistant")) {
        flushPendingToolResults();
      }
      // If new tool calls arrive while older ones are pending, flush the old ones first.
      if (pending.size > 0 && toolCalls.length > 0) {
        flushPendingToolResults();
      }
    }

    const finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));
    if (!finalMessage) {
      return undefined;
    }
    const result = originalAppend(finalMessage as never);

    const sessionFile = (
      sessionManager as { getSessionFile?: () => string | null }
    ).getSessionFile?.();
    if (sessionFile) {
      emitSessionTranscriptUpdate(sessionFile);
    }

    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        pending.set(call.id, call.name);
      }
    }

    return result;
  };

  // Monkey-patch appendMessage with our guarded version.
  sessionManager.appendMessage = guardedAppend as SessionManager["appendMessage"];

  return {
    flushPendingToolResults,
    getPendingIds: () => Array.from(pending.keys()),
  };
}
