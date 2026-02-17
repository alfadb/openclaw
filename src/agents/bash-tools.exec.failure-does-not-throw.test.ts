import { describe, expect, it } from "vitest";

const isWin = process.platform === "win32";

describe("exec tool failure handling", () => {
  it("returns a failed tool result (does not throw) when command exits non-zero", async () => {
    if (isWin) {
      return;
    }

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
    });

    const result = await tool.execute("call1", {
      command: "node -e \"console.error('boom'); process.exit(7)\"",
      timeout: 30,
    });

    expect(result.details?.status).toBe("completed");
    if (result.details && result.details.status === "completed") {
      expect(result.details.exitCode).toBe(7);
      expect(result.details.aggregated).toContain("boom");
      expect(result.details.aggregated).toContain("Command exited with code 7");
    }

    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
    expect(text).toContain("boom");
    expect(text).toContain("Command exited with code 7");
  });
});
