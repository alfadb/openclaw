import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { addReactionFeishu, removeReactionFeishu } from "./reactions.js";

export type StatusReactionState = {
  emojiType: string;
  reactionId: string;
};

export async function replaceStatusReaction(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  nextEmojiType: string;
  prev?: StatusReactionState;
  accountId?: string;
  runtime?: RuntimeEnv;
}): Promise<StatusReactionState> {
  const { cfg, messageId, nextEmojiType, prev, accountId, runtime } = params;

  const { reactionId } = await addReactionFeishu({
    cfg,
    messageId,
    emojiType: nextEmojiType,
    accountId,
  });

  if (prev?.reactionId) {
    try {
      await removeReactionFeishu({
        cfg,
        messageId,
        reactionId: prev.reactionId,
        accountId,
      });
    } catch (err) {
      runtime?.log?.(
        `feishu[${accountId ?? "default"}]: failed to remove previous status reaction: ${String(err)}`,
      );
    }
  }

  return { emojiType: nextEmojiType, reactionId };
}
