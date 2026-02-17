import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSendMessageFeishu, mockReplaceStatusReaction } = vi.hoisted(() => ({
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "m-out", chatId: "c1" }),
  mockReplaceStatusReaction: vi.fn().mockResolvedValue({ emojiType: "DONE", reactionId: "r-done" }),
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
}));

vi.mock("./status-reaction.js", () => ({
  replaceStatusReaction: mockReplaceStatusReaction,
}));

import {
  readFeishuInFlightStore,
  writeFeishuInFlightStore,
  type FeishuInFlightStore,
} from "./inflight-store.js";
import { feishuOutbound } from "./outbound.js";
import { FeishuEmoji } from "./reactions.js";
import { setFeishuRuntime } from "./runtime.js";

describe("feishuOutbound", () => {
  let stateDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-test-"));
    setFeishuRuntime({
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        text: {
          chunkMarkdownText: (text: string) => [text],
        },
      },
    } as unknown as PluginRuntime);
  });

  afterEach(async () => {
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes replyToId through to sendMessageFeishu.replyToMessageId", async () => {
    const cfg = {} as ClawdbotConfig;
    await feishuOutbound.sendText({
      cfg,
      to: "chat:c1",
      text: "hello",
      replyToId: "msg-anchor",
      accountId: "default",
    });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: "msg-anchor" }),
    );
  });

  it("auto-finalizes waiting in-flight task when delivering a reply to its anchor", async () => {
    const cfg = { channels: { feishu: {} } } as unknown as ClawdbotConfig;

    const { filePath, store } = await readFeishuInFlightStore({ stateDir, accountId: "default" });
    const next: FeishuInFlightStore = {
      ...store,
      tasks: [
        {
          id: "t1",
          provider: "feishu",
          accountId: "default",
          chatId: "oc-dm",
          chatType: "direct",
          userOpenId: "ou-user",
          messageId: "msg-anchor",
          originalText: "hi",
          state: "waiting",
          reaction: { emojiType: FeishuEmoji.ALARM, reactionId: "r1" },
          updatedAtMs: Date.now(),
        },
      ],
    };
    await writeFeishuInFlightStore({ filePath, store: next });

    await feishuOutbound.sendText({
      cfg,
      to: "user:ou-user",
      text: "done",
      replyToId: "msg-anchor",
      accountId: "default",
    });

    expect(mockReplaceStatusReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-anchor",
        nextEmojiType: FeishuEmoji.DONE,
      }),
    );

    const { store: after } = await readFeishuInFlightStore({ stateDir, accountId: "default" });
    expect(after.tasks.find((t) => t.id === "t1")).toBeUndefined();
  });
});
