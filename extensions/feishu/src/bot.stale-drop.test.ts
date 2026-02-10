import { describe, expect, it, vi } from "vitest";

vi.mock("./send.js", async () => {
  const actual = (await vi.importActual<any>("./send.js")) as any;
  return {
    ...actual,
    sendMessageFeishu: vi.fn(async () => ({ messageId: "reply" })),
  };
});

import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { sendMessageFeishu } from "./send.js";

// Minimal runtime stub for stateDir resolution.
vi.mock("./runtime.js", () => {
  return {
    getFeishuRuntime: () => ({
      state: {
        resolveStateDir: () => "/tmp/openclaw-feishu-test-state",
      },
    }),
  };
});

describe("feishu stale drop", () => {
  it("replies stale notice and does not call model dispatch when sentAt older than watermark", async () => {
    // Seed watermark state.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = "/tmp/openclaw-feishu-test-state/feishu/inbound";
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "default-oc_test.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({ lastProcessedSentAtMs: 2000, recentMessageIds: [] }, null, 2),
    );

    const cfg: any = {
      channels: {
        feishu: {
          enabled: true,
          staleDrop: { enabled: true, reply: true, skewWindowMs: 0, recentIdsLimit: 10 },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou_test" },
        sender_type: "user",
        tenant_key: "t",
      },
      message: {
        message_id: "om_old",
        chat_id: "oc_test",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "old" }),
        create_time: "1000",
      },
    };

    await handleFeishuMessage({ cfg, event, runtime: undefined, accountId: "default" } as any);

    expect(sendMessageFeishu).toHaveBeenCalledTimes(1);
    const args = (sendMessageFeishu as any).mock.calls[0]?.[0];
    expect(args.replyToMessageId).toBe("om_old");
    expect(String(args.text)).toContain("过期消息");
    expect(String(args.text)).toContain("reason=out_of_order_delivery");
  });
});
