/**
 * Feishu rendering has practical limits beyond simple character counts.
 * In particular, very long unbroken tokens (e.g. JSON on a single line) may
 * render as truncated content in Feishu post/card markdown.
 *
 * This file provides conservative, best-effort sanitizers to improve
 * deliverability + readability without changing semantics.
 */

export function softWrapLongTokens(text: string, opts?: { tokenLimit?: number; wrapAt?: number }) {
  const tokenLimit = opts?.tokenLimit ?? 200;
  const wrapAt = opts?.wrapAt ?? 120;

  // Split on whitespace while preserving it.
  // We only wrap tokens that are very long AND contain no newlines.
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (!part) return part;
      if (/\s+/.test(part)) return part;
      if (part.includes("\n")) return part;
      if (part.length <= tokenLimit) return part;

      // Soft-wrap by inserting newlines every wrapAt characters.
      let out = "";
      for (let i = 0; i < part.length; i += wrapAt) {
        out += part.slice(i, i + wrapAt);
        if (i + wrapAt < part.length) out += "\n";
      }
      return out;
    })
    .join("");
}

export function formatInlineJsonAfterPrefix(text: string, prefix: string): string {
  // Example line:
  //   fetched quoted message: {"title":"", ...}
  // We pretty-print the JSON and wrap it in a fenced code block.
  const idx = text.indexOf(prefix);
  if (idx < 0) return text;

  // Only replace occurrences that look like: prefix + optional space + '{'
  // We do a line-level transform to avoid accidental huge replacements.
  const lines = text.split(/\r?\n/);
  let changed = false;
  const next = lines.map((line) => {
    const p = line.indexOf(prefix);
    if (p < 0) return line;
    const after = line.slice(p + prefix.length).trimStart();
    if (!after.startsWith("{")) return line;

    try {
      const parsed = JSON.parse(after);
      const pretty = JSON.stringify(parsed, null, 2);
      changed = true;
      return `${line.slice(0, p + prefix.length)}\n\n\`\`\`json\n${pretty}\n\`\`\``;
    } catch {
      return line;
    }
  });

  return changed ? next.join("\n") : text;
}

export function sanitizeForFeishu(text: string): string {
  let out = text;

  // Best-effort prettify for our own diagnostic line patterns.
  out = formatInlineJsonAfterPrefix(out, "fetched quoted message:");

  // Generic safety net.
  out = softWrapLongTokens(out);

  return out;
}
