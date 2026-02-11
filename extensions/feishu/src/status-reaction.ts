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

  // Feishu reaction create can be effectively idempotent for the same emoji on the same message.
  // In that case, the returned reaction_id may equal the previous one.
  // Never remove the "previous" reaction if it is actually the same as the newly created one,
  // otherwise we would accidentally clear the final status reaction.
  const { reactionId } = await addReactionFeishu({
    cfg,
    messageId,
    emojiType: nextEmojiType,
    accountId,
  });

  if (prev?.reactionId && prev.reactionId !== reactionId) {
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
