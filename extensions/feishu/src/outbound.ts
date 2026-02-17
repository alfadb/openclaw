import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { readFeishuInFlightStore, removeTask, writeFeishuInFlightStore } from "./inflight-store.js";
import { sendMediaFeishu } from "./media.js";
import { FeishuEmoji } from "./reactions.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";
import { replaceStatusReaction } from "./status-reaction.js";

async function maybeFinalizeWaitingInFlightTask(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  accountId?: string | null;
  replyToMessageId?: string | null;
}): Promise<void> {
  const { cfg, accountId, replyToMessageId } = params;
  const anchor = replyToMessageId?.trim();
  if (!anchor) {
    return;
  }

  try {
    const runtime = getFeishuRuntime();
    const stateDir = runtime.state.resolveStateDir();
    const { filePath, store } = await readFeishuInFlightStore({
      stateDir,
      accountId: accountId ?? "default",
    });

    const task = store.tasks.find((t) => t.messageId === anchor);
    // Only auto-finalize tasks that were explicitly put into waiting state.
    // This is the followup/backlog queue case: the message had no immediate reply,
    // but later followup drain will reply-to this anchor.
    if (!task || task.state !== "waiting" || task.accountId !== (accountId ?? "default")) {
      return;
    }

    // Mark DONE reaction (keep reaction on the message), then drop the in-flight record.
    await replaceStatusReaction({
      cfg,
      messageId: task.messageId,
      nextEmojiType: FeishuEmoji.DONE,
      prev: task.reaction
        ? { emojiType: task.reaction.emojiType, reactionId: task.reaction.reactionId }
        : undefined,
      accountId: accountId ?? undefined,
    });

    const nextStore = removeTask(store, task.id);
    await writeFeishuInFlightStore({ filePath, store: nextStore });
  } catch {
    // Best-effort only.
  }
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, replyToId }) => {
    const result = await sendMessageFeishu({
      cfg,
      to,
      text,
      replyToMessageId: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });

    await maybeFinalizeWaitingInFlightTask({
      cfg,
      accountId: accountId ?? null,
      replyToMessageId: replyToId ?? null,
    });

    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({
        cfg,
        to,
        text,
        replyToMessageId: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
        });

        await maybeFinalizeWaitingInFlightTask({
          cfg,
          accountId: accountId ?? null,
          replyToMessageId: replyToId ?? null,
        });

        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          replyToMessageId: replyToId ?? undefined,
          accountId: accountId ?? undefined,
        });

        await maybeFinalizeWaitingInFlightTask({
          cfg,
          accountId: accountId ?? null,
          replyToMessageId: replyToId ?? null,
        });

        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      replyToMessageId: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });

    await maybeFinalizeWaitingInFlightTask({
      cfg,
      accountId: accountId ?? null,
      replyToMessageId: replyToId ?? null,
    });

    return { channel: "feishu", ...result };
  },
};
