import { describe, expect, it } from "vitest";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

describe("feishu inbound message create_time", () => {
  it("parses message.create_time into ctx.createTimeMs", () => {
    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou_test" },
        sender_type: "user",
        tenant_key: "t",
      },
      message: {
        message_id: "om_test",
        chat_id: "oc_test",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi" }),
        create_time: "1609073151345",
      },
    };

    const ctx = parseFeishuMessageEvent(event);
    expect(ctx.createTimeMs).toBe(1609073151345);
  });
});
