import { describe, expect, it } from "vitest";

const isWin = process.platform === "win32";

describe("exec tool result cap", () => {
  it("truncates foreground gateway exec output before returning tool result", async () => {
    if (isWin) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      resultMaxChars: 1000,
    });

    const result = await tool.execute("call1", {
      command: "node -e \"process.stdout.write('a'.repeat(6000))\"",
      timeout: 30,
    });

    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
    expect(text).toContain("[TRUNCATED originalChars=");
    expect(result.details?.status).toBe("completed");
    if (
      result.details &&
      (result.details.status === "completed" || result.details.status === "failed")
    ) {
      expect(result.details.truncated).toBe(true);
      expect(typeof result.details.originalChars).toBe("number");
      expect(typeof result.details.keptChars).toBe("number");
      expect(result.details.originalChars).toBeGreaterThan(result.details.keptChars ?? 0);
      expect(result.details.aggregated).toContain("[TRUNCATED originalChars=");
    }
  });
});
