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
      command: "bash -lc 'echo boom 1>&2; exit 7'",
      timeout: 30,
    });

    expect(result.details?.status).toBe("failed");
    if (result.details && result.details.status === "failed") {
      expect(result.details.exitCode).toBe(7);
      expect(result.details.error).toBeTruthy();
    }

    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
    expect(text).toContain("Command failed");
    expect(text).toContain("boom");
  });
});
