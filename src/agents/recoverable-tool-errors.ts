export type RecoverableToolErrorKind = "EDIT_EXACT_MATCH_NOT_FOUND";

export type RecoverableToolError = {
  kind: RecoverableToolErrorKind;
  toolName: string;
  path?: string;
  rawError?: string;
};

type LastToolError = {
  toolName: string;
  meta?: string;
  error?: string;
};

export function classifyRecoverableToolError(
  lastToolError: LastToolError | undefined,
): RecoverableToolError | null {
  if (!lastToolError) {
    return null;
  }
  const toolName = (lastToolError.toolName ?? "").trim().toLowerCase();
  const error = lastToolError.error ?? "";

  if (toolName === "edit") {
    const matchNotFound = /Could not find the exact text\b/i.test(error);
    if (matchNotFound) {
      const fileMatch = error.match(/Could not find the exact text in ([^\n]+?)\.\s*The old text/i);
      const path = fileMatch?.[1]?.trim();
      return {
        kind: "EDIT_EXACT_MATCH_NOT_FOUND",
        toolName,
        path: path || undefined,
        rawError: error,
      };
    }
  }

  return null;
}

export function buildEditExactMatchRecoverySystemPrompt(args: {
  path: string;
  fileHead: string;
  maxLines: number;
}): string {
  return [
    "You are in an automatic recovery step.",
    "A previous edit() tool call failed with: EDIT_EXACT_MATCH_NOT_FOUND.",
    "Your job: recover by reading the current file content and retrying edit with a smaller/unique oldText anchor.",
    "Constraints:",
    "- Prefer calling read(path) again if you need more context.",
    "- Keep oldText minimal and uniquely identifiable (e.g., a single header line).",
    "- If you cannot safely repair with edit after one attempt, explain why and ask before using write().",
    "",
    `Target path: ${args.path}`,
    `Here are the first ~${args.maxLines} lines of the file (may be truncated):`,
    "```",
    args.fileHead,
    "```",
  ].join("\n");
}
