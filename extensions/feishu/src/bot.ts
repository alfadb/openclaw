import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type { FeishuMessageContext, FeishuMediaInfo, ResolvedFeishuAccount } from "./types.js";
import type { DynamicAgentCreationConfig } from "./types.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import {
  clampOriginalText,
  createInFlightId,
  getLastInterruptibleTask,
  readFeishuInFlightStore,
  removeTask,
  setLastInterruptible,
  upsertTask,
  writeFeishuInFlightStore,
  type FeishuInFlightTask,
} from "./inflight-store.js";
import { downloadImageFeishu, downloadMessageResourceFeishu } from "./media.js";
import { extractMentionTargets, extractMessageBody, isMentionForwardRequest } from "./mention.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { FeishuEmoji, listReactionsFeishu, removeReactionFeishu } from "./reactions.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, sendMessageFeishu } from "./send.js";
// status-protocol helpers are implemented inline in this file (setFeishuStatus)
import { replaceStatusReaction } from "./status-reaction.js";

// --- Message deduplication ---
// Prevent duplicate processing when WebSocket reconnects or Feishu redelivers messages.
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // cleanup every 5 minutes
const processedMessageIds = new Map<string, number>(); // messageId -> gateway timestamp
let lastCleanupTime = Date.now();

// Persistent per-chat watermark + recent message IDs.
// Purpose:
// 1) Survive gateway restarts (in-memory dedup is lost on restart).
// 2) Drop stale/out-of-order deliveries based on Feishu message.create_time.
const FEISHU_INBOUND_STATE_DIR = "feishu/inbound";
const FEISHU_RECENT_IDS_LIMIT = 250;
const FEISHU_STALE_SKEW_WINDOW_MS = 5_000;

// (deprecated) use isContinueMessage() below
function resolveStaleDropConfig(feishuCfg: any): {
  enabled: boolean;
  reply: boolean;
  skewWindowMs: number;
  recentIdsLimit: number;
} {
  const cfg = (feishuCfg?.staleDrop ?? {}) as {
    enabled?: boolean;
    reply?: boolean;
    skewWindowMs?: number;
    recentIdsLimit?: number;
  };

  return {
    enabled: cfg.enabled !== false,
    reply: cfg.reply !== false,
    skewWindowMs:
      typeof cfg.skewWindowMs === "number" && Number.isFinite(cfg.skewWindowMs)
        ? Math.max(0, Math.floor(cfg.skewWindowMs))
        : FEISHU_STALE_SKEW_WINDOW_MS,
    recentIdsLimit:
      typeof cfg.recentIdsLimit === "number" && Number.isFinite(cfg.recentIdsLimit)
        ? Math.max(1, Math.floor(cfg.recentIdsLimit))
        : FEISHU_RECENT_IDS_LIMIT,
  };
}

type FeishuInboundState = {
  lastProcessedSentAtMs?: number;
  recentMessageIds?: string[];
  updatedAtMs?: number;
};

async function readFeishuInboundState(params: {
  stateDir: string;
  accountId: string;
  chatId: string;
}): Promise<{ filePath: string; state: FeishuInboundState }> {
  const { stateDir, accountId, chatId } = params;
  const safeChat = encodeURIComponent(chatId);
  const dir = path.join(stateDir, FEISHU_INBOUND_STATE_DIR);
  const filePath = path.join(dir, `${accountId}-${safeChat}.json`);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const state = JSON.parse(raw) as FeishuInboundState;
    return { filePath, state: state && typeof state === "object" ? state : {} };
  } catch {
    return { filePath, state: {} };
  }
}

async function writeFeishuInboundState(params: {
  filePath: string;
  state: FeishuInboundState;
}): Promise<void> {
  const { filePath, state } = params;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, filePath);
}

const CONTINUE_PATTERNS = [/^继续\b/i, /^continue\b/i, /^resume\b/i];

function isContinueMessage(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return CONTINUE_PATTERNS.some((re) => re.test(t));
}

async function setFeishuStatus(params: {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  stateDir: string;
  accountId: string;
  chatId: string;
  chatType: "direct" | "group";
  userOpenId?: string;
  messageId: string;
  taskId: string;
  nextState: FeishuInFlightTask["state"];
  nextEmojiType: string;
  originalText?: string;
  truncated?: boolean;
}): Promise<void> {
  const {
    cfg,
    runtime,
    stateDir,
    accountId,
    chatId,
    chatType,
    userOpenId,
    messageId,
    taskId,
    nextState,
    nextEmojiType,
    originalText,
    truncated,
  } = params;

  const { filePath, store } = await readFeishuInFlightStore({ stateDir, accountId });
  const now = Date.now();
  const prev = store.tasks.find((t) => t.id === taskId);

  let reaction = prev?.reaction;
  try {
    reaction = await replaceStatusReaction({
      cfg,
      messageId,
      nextEmojiType,
      prev: reaction
        ? { emojiType: reaction.emojiType, reactionId: reaction.reactionId }
        : undefined,
      accountId,
      runtime,
    });
  } catch (err) {
    runtime?.log?.(`feishu[${accountId}]: failed to set status reaction: ${String(err)}`);
  }

  const task: FeishuInFlightTask = {
    id: taskId,
    provider: "feishu",
    accountId,
    chatId,
    chatType,
    userOpenId,
    messageId,
    originalText: originalText ?? prev?.originalText ?? "",
    truncated: truncated ?? prev?.truncated,
    state: nextState,
    reaction: reaction
      ? {
          emojiType: reaction.emojiType,
          reactionId: reaction.reactionId,
        }
      : prev?.reaction,
    runId: prev?.runId,
    resumeAttempts: prev?.resumeAttempts ?? 0,
    updatedAtMs: now,
    interruptedHandled: prev?.interruptedHandled,
  };

  const nextStore = upsertTask(store, task);
  await writeFeishuInFlightStore({ filePath, store: nextStore });
}

function tryRecordMessage(messageId: string): boolean {
  const now = Date.now();

  // Throttled cleanup: evict expired entries at most once per interval
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
    }
    lastCleanupTime = now;
  }

  if (processedMessageIds.has(messageId)) return false;

  // Evict oldest entries if cache is full
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }

  processedMessageIds.set(messageId, now);
  return true;
}

// --- Permission error extraction ---
// Extract permission grant URL from Feishu API error response.
type PermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;

  // Axios error structure: err.response.data contains the Feishu error
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;

  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };

  // Feishu permission error code: 99991672
  if (feishuErr.code !== 99991672) return null;

  // Extract the grant URL from the error message (contains the direct link)
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0];

  return {
    code: feishuErr.code,
    message: msg,
    grantUrl,
  };
}

// --- Sender name resolution (so the agent can distinguish who is speaking in group chats) ---
// Cache display names by open_id to avoid an API call on every message.
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type SenderNameResult = {
  name?: string;
  permissionError?: PermissionError;
};

async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderOpenId: string;
  log: (...args: any[]) => void;
}): Promise<SenderNameResult> {
  const { account, senderOpenId, log } = params;
  if (!account.configured) return {};
  if (!senderOpenId) return {};

  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };

  try {
    const client = createFeishuClient(account);

    // contact/v3/users/:user_id?user_id_type=open_id
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });

    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;

    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }

    return {};
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }

    // Best-effort. Don't fail message handling if name lookup fails.
    log(`feishu: failed to resolve sender name for ${senderOpenId}: ${String(err)}`);
    return {};
  }
}

export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    /** Message sent time (ms since epoch) as a string, per Feishu event payload. */
    create_time?: string;
    chat_id: string;
    chat_type: "p2p" | "group";
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};

function parseMessageContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "post") {
      // Extract text content from rich text post
      const { textContent } = parsePostContent(content);
      return textContent;
    }
    return content;
  } catch {
    return content;
  }
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0) return false;
  if (!botOpenId) return mentions.length > 0;
  return mentions.some((m) => m.id.open_id === botOpenId);
}

function stripBotMention(
  text: string,
  mentions?: FeishuMessageEvent["message"]["mentions"],
): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    result = result.replace(new RegExp(`@${mention.name}\\s*`, "g"), "").trim();
    result = result.replace(new RegExp(mention.key, "g"), "").trim();
  }
  return result;
}

/**
 * Parse media keys from message content based on message type.
 */
function parseMediaKeys(
  content: string,
  messageType: string,
): {
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
} {
  try {
    const parsed = JSON.parse(content);
    switch (messageType) {
      case "image":
        return { imageKey: parsed.image_key };
      case "file":
        return { fileKey: parsed.file_key, fileName: parsed.file_name };
      case "audio":
        return { fileKey: parsed.file_key };
      case "video":
        // Video has both file_key (video) and image_key (thumbnail)
        return { fileKey: parsed.file_key, imageKey: parsed.image_key };
      case "sticker":
        return { fileKey: parsed.file_key };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Parse post (rich text) content and extract embedded image keys.
 * Post structure: { title?: string, content: [[{ tag, text?, image_key?, ... }]] }
 */
function parsePostContent(content: string): {
  textContent: string;
  imageKeys: string[];
} {
  try {
    const parsed = JSON.parse(content);
    const title = parsed.title || "";
    const contentBlocks = parsed.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === "text") {
            textContent += element.text || "";
          } else if (element.tag === "a") {
            // Link: show text or href
            textContent += element.text || element.href || "";
          } else if (element.tag === "at") {
            // Mention: @username
            textContent += `@${element.user_name || element.user_id || ""}`;
          } else if (element.tag === "img" && element.image_key) {
            // Embedded image
            imageKeys.push(element.image_key);
          }
        }
        textContent += "\n";
      }
    }

    return {
      textContent: textContent.trim() || "[富文本消息]",
      imageKeys,
    };
  } catch {
    return { textContent: "[富文本消息]", imageKeys: [] };
  }
}

/**
 * Infer placeholder text based on message type.
 */
function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message, downloading and saving to disk.
 * Similar to Discord's resolveMediaList().
 */
async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;

  // Only process media message types (including post for embedded images)
  const mediaTypes = ["image", "file", "audio", "video", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  const core = getFeishuRuntime();

  // Handle post (rich text) messages with embedded images
  if (messageType === "post") {
    const { imageKeys } = parsePostContent(content);
    if (imageKeys.length === 0) {
      return [];
    }

    log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);

    for (const imageKey of imageKeys) {
      try {
        // Embedded images in post use messageResource API with image_key as file_key
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
          accountId,
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });

        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    let buffer: Buffer;
    let contentType: string | undefined;
    let fileName: string | undefined;

    // For message media, always use messageResource API
    // The image.get API is only for images uploaded via im/v1/images, not for message attachments
    const fileKey = mediaKeys.imageKey || mediaKeys.fileKey;
    if (!fileKey) {
      return [];
    }

    const resourceType = messageType === "image" ? "image" : "file";
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
      accountId,
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;

    // Detect mime type if not provided
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }

    // Save to disk using core's saveMediaBuffer
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );

    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });

    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }

  return out;
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 */
function buildFeishuMediaPayload(mediaList: FeishuMediaInfo[]): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const content = stripBotMention(rawContent, event.message.mentions);

  const createTimeMs = event.message.create_time
    ? Number.parseInt(event.message.create_time, 10)
    : undefined;

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: event.sender.sender_id.user_id || event.sender.sender_id.open_id || "",
    senderOpenId: event.sender.sender_id.open_id || "",
    chatType: event.message.chat_type,
    mentionedBot,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    createTimeMs: Number.isFinite(createTimeMs as number) ? createTimeMs : undefined,
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
      // Extract message body (remove all @ placeholders)
      const allMentionKeys = (event.message.mentions ?? []).map((m) => m.key);
      ctx.mentionMessageBody = extractMessageBody(content, allMentionKeys);
    }
  }

  return ctx;
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, botOpenId, runtime, chatHistories, accountId } = params;

  // Resolve account with merged config
  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Dedup check: skip if this message was already processed
  const messageId = event.message.message_id;
  if (!tryRecordMessage(messageId)) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId);
  const isGroup = ctx.chatType === "group";

  const staleCfg = resolveStaleDropConfig(feishuCfg);

  // Persistent dedup + stale drop (best-effort).
  // If Feishu redelivers old messages hours later, do not pass them to the model.
  if (staleCfg.enabled) {
    try {
      const stateDir = getFeishuRuntime().state.resolveStateDir();
      const { filePath, state } = await readFeishuInboundState({
        stateDir,
        accountId: account.accountId,
        chatId: ctx.chatId,
      });

      const recent = Array.isArray(state.recentMessageIds) ? state.recentMessageIds : [];
      if (recent.includes(ctx.messageId)) {
        log(
          `feishu[${account.accountId}]: skipping duplicate message ${ctx.messageId} (persistent)`,
        );
        return;
      }

      const sentAt = ctx.createTimeMs;
      const last = state.lastProcessedSentAtMs;
      if (typeof sentAt === "number" && Number.isFinite(sentAt) && typeof last === "number") {
        if (sentAt < last - staleCfg.skewWindowMs) {
          const staleText =
            `过期消息，被忽略。\n` +
            `sentAt=${sentAt} (${new Date(sentAt).toISOString()})\n` +
            `lastProcessedSentAt=${last} (${new Date(last).toISOString()})\n` +
            `reason=out_of_order_delivery`;

          if (staleCfg.reply) {
            // Reply directly, do not involve the model.
            await sendMessageFeishu({
              cfg,
              // For replies, the message_id is the true anchor; `to` is just used for target validation.
              to: isGroup ? ctx.chatId : ctx.senderOpenId,
              replyToMessageId: ctx.messageId,
              text: staleText,
              accountId: account.accountId,
            });
          }

          // Record as seen to prevent repeated stale deliveries.
          recent.push(ctx.messageId);
          const nextRecent = recent.slice(-staleCfg.recentIdsLimit);
          await writeFeishuInboundState({
            filePath,
            state: {
              ...state,
              recentMessageIds: nextRecent,
              updatedAtMs: Date.now(),
            },
          });
          return;
        }
      }

      // Update watermark + recent IDs.
      const nextLast =
        typeof sentAt === "number" && Number.isFinite(sentAt) ? Math.max(last ?? 0, sentAt) : last;
      recent.push(ctx.messageId);
      const nextRecent = recent.slice(-staleCfg.recentIdsLimit);
      await writeFeishuInboundState({
        filePath,
        state: {
          lastProcessedSentAtMs: nextLast,
          recentMessageIds: nextRecent,
          updatedAtMs: Date.now(),
        },
      });
    } catch (err) {
      // Best-effort; never block message handling.
      log(`feishu[${account.accountId}]: persistent dedup/stale check failed: ${String(err)}`);
    }
  }

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  const senderResult = await resolveFeishuSenderName({
    account,
    senderOpenId: ctx.senderOpenId,
    log,
  });
  if (senderResult.name) ctx = { ...ctx, senderName: senderResult.name };

  // Track permission error to inform agent later (with cooldown to avoid repetition)
  let permissionErrorForAgent: PermissionError | undefined;
  if (senderResult.permissionError) {
    const appKey = account.appId ?? "default";
    const now = Date.now();
    const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

    if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
      permissionErrorNotifiedAt.set(appKey, now);
      permissionErrorForAgent = senderResult.permissionError;
    }
  }

  const sentAtLabel = ctx.createTimeMs ? ` sentAt=${new Date(ctx.createTimeMs).toISOString()}` : "";
  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})${sentAtLabel}`,
  );

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  if (isGroup) {
    const groupPolicy = feishuCfg?.groupPolicy ?? "open";
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    // DEBUG: log(`feishu[${account.accountId}]: groupPolicy=${groupPolicy}`);
    const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });

    // Check if this GROUP is allowed (groupAllowFrom contains group IDs like oc_xxx, not user IDs)
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId, // Check group ID, not sender ID
      senderName: undefined,
    });

    if (!groupAllowed) {
      log(`feishu[${account.accountId}]: sender ${ctx.senderOpenId} not in group allowlist`);
      return;
    }

    // Additional sender-level allowlist check if group has specific allowFrom config
    const senderAllowFrom = groupConfig?.allowFrom ?? [];
    if (senderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: senderAllowFrom,
        senderId: ctx.senderOpenId,
        senderName: ctx.senderName,
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        return;
      }
    }

    const { requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig,
    });

    if (requireMention && !ctx.mentionedBot && !isContinueMessage(ctx.content)) {
      log(
        `feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot, recording to history`,
      );
      if (chatHistories) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.chatId,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }
  } else {
    const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
    const allowFrom = feishuCfg?.allowFrom ?? [];

    if (dmPolicy === "allowlist") {
      const match = resolveFeishuAllowlistMatch({
        allowFrom,
        senderId: ctx.senderOpenId,
      });
      if (!match.allowed) {
        log(`feishu[${account.accountId}]: sender ${ctx.senderOpenId} not in DM allowlist`);
        return;
      }
    }
  }

  try {
    const core = getFeishuRuntime();
    const stateDir = core.state.resolveStateDir();

    // "继续" support: resume the last interrupted/failed task for this chat.
    const wantsContinue = isContinueMessage(ctx.content);
    const { filePath: inflightPath, store: inflightStore } = await readFeishuInFlightStore({
      stateDir,
      accountId: account.accountId,
    });

    let inFlightTaskId = createInFlightId();
    let anchorMessageId = ctx.messageId; // where reactions + replies attach
    let originalTextForRun = ctx.content;
    let truncateInfo: { text: string; truncated: boolean } | undefined;
    let resumeSourceTask: FeishuInFlightTask | undefined;

    if (wantsContinue) {
      const last = getLastInterruptibleTask(inflightStore, ctx.chatId);
      if (
        last &&
        (last.state === "interrupted" || last.state === "failed") &&
        (last.resumeAttempts ?? 0) < 2 &&
        (!isGroup || !last.userOpenId || last.userOpenId === ctx.senderOpenId)
      ) {
        resumeSourceTask = last;
        inFlightTaskId = last.id;
        anchorMessageId = last.messageId;
        originalTextForRun = last.originalText;
      } else {
        // No resumable task; minimal guidance (rare and acceptable to send 1 line).
        await sendMessageFeishu({
          cfg,
          to: isGroup ? ctx.chatId : ctx.senderOpenId,
          replyToMessageId: ctx.messageId,
          text: "我这边没找到可继续的上一条任务，你把要做的事再发一次我就能继续。",
          accountId: account.accountId,
        });
        return;
      }
    }

    // Create/refresh in-flight record and set initial RECEIVED status.
    if (!resumeSourceTask) {
      truncateInfo = clampOriginalText(originalTextForRun, 8000);
      await setFeishuStatus({
        cfg,
        runtime,
        stateDir,
        accountId: account.accountId,
        chatId: ctx.chatId,
        chatType: isGroup ? "group" : "direct",
        userOpenId: ctx.senderOpenId,
        messageId: anchorMessageId,
        taskId: inFlightTaskId,
        nextState: "received",
        nextEmojiType: FeishuEmoji.GLANCE,
        originalText: truncateInfo.text,
        truncated: truncateInfo.truncated,
      });
    } else {
      // Resuming: bump attempts + move back to received.
      const resumed: FeishuInFlightTask = {
        ...resumeSourceTask,
        resumeAttempts: (resumeSourceTask.resumeAttempts ?? 0) + 1,
        updatedAtMs: Date.now(),
        interruptedHandled: true,
      };
      let nextStore = upsertTask(inflightStore, resumed);
      nextStore = setLastInterruptible(nextStore, ctx.chatId, resumed.id);
      await writeFeishuInFlightStore({ filePath: inflightPath, store: nextStore });
      await setFeishuStatus({
        cfg,
        runtime,
        stateDir,
        accountId: account.accountId,
        chatId: ctx.chatId,
        chatType: isGroup ? "group" : "direct",
        userOpenId: ctx.senderOpenId,
        messageId: anchorMessageId,
        taskId: inFlightTaskId,
        nextState: "received",
        nextEmojiType: FeishuEmoji.GLANCE,
      });
    }

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;

    // Resolve peer ID for session routing
    // When topicSessionMode is enabled, messages within a topic (identified by root_id)
    // get a separate session from the main group chat.
    let peerId = isGroup ? ctx.chatId : ctx.senderOpenId;
    if (isGroup && ctx.rootId) {
      const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });
      const topicSessionMode =
        groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
      if (topicSessionMode === "enabled") {
        // Use chatId:topic:rootId as peer ID for topic-scoped sessions
        peerId = `${ctx.chatId}:topic:${ctx.rootId}`;
        log(`feishu[${account.accountId}]: topic session isolation enabled, peer=${peerId}`);
      }
    }

    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
    });

    // Dynamic agent creation for DM users
    // When enabled, creates a unique agent instance with its own workspace for each DM user.
    let effectiveCfg = cfg;
    if (!isGroup && route.matchedBy === "default") {
      const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
      if (dynamicCfg?.enabled) {
        const runtime = getFeishuRuntime();
        const result = await maybeCreateDynamicAgent({
          cfg,
          runtime,
          senderOpenId: ctx.senderOpenId,
          dynamicCfg,
          log: (msg) => log(msg),
        });
        if (result.created) {
          effectiveCfg = result.updatedCfg;
          // Re-resolve route with updated config
          route = core.channel.routing.resolveAgentRoute({
            cfg: result.updatedCfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: { kind: "direct", id: ctx.senderOpenId },
          });
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Feishu[${account.accountId}] message in group ${ctx.chatId}`
      : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `feishu:message:${ctx.chatId}:${ctx.messageId}`,
    });

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const mediaPayload = buildFeishuMediaPayload(mediaList);

    // Fetch quoted/replied message content if parentId exists
    let quotedContent: string | undefined;
    if (ctx.parentId) {
      try {
        const quotedMsg = await getMessageFeishu({
          cfg,
          messageId: ctx.parentId,
          accountId: account.accountId,
        });
        if (quotedMsg) {
          quotedContent = quotedMsg.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`,
          );
        }
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
      }
    }

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with quoted content if available
    let messageBody = ctx.content;
    if (quotedContent) {
      messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
    }

    // Include a readable speaker label so the model can attribute instructions.
    // (DMs already have per-sender sessions, but the prefix is still useful for clarity.)
    const speaker = ctx.senderName ?? ctx.senderOpenId;
    messageBody = `${speaker}: ${messageBody}`;

    // If there are mention targets, inform the agent that replies will auto-mention them
    if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
      const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
      messageBody += `\n\n[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
    }

    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;

    // If there's a permission error, dispatch a separate notification first
    if (permissionErrorForAgent) {
      const grantUrl = permissionErrorForAgent.grantUrl ?? "";
      const permissionNotifyBody = `[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;

      const permissionBody = core.channel.reply.formatAgentEnvelope({
        channel: "Feishu",
        from: envelopeFrom,
        timestamp: new Date(),
        envelope: envelopeOptions,
        body: permissionNotifyBody,
      });

      const permissionCtx = core.channel.reply.finalizeInboundContext({
        Body: permissionBody,
        BodyForAgent: permissionNotifyBody,
        RawBody: permissionNotifyBody,
        CommandBody: permissionNotifyBody,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : undefined,
        SenderName: "system",
        SenderId: "system",
        Provider: "feishu" as const,
        Surface: "feishu" as const,
        MessageSid: `${ctx.messageId}:permission-error`,
        Timestamp: Date.now(),
        WasMentioned: false,
        CommandAuthorized: true,
        OriginatingChannel: "feishu" as const,
        OriginatingTo: feishuTo,
      });

      const {
        dispatcher: permDispatcher,
        replyOptions: permReplyOptions,
        markDispatchIdle: markPermIdle,
      } = createFeishuReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        replyToMessageId: ctx.messageId,
        accountId: account.accountId,
      });

      log(`feishu[${account.accountId}]: dispatching permission error notification to agent`);

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: permissionCtx,
        cfg,
        dispatcher: permDispatcher,
        replyOptions: permReplyOptions,
      });

      markPermIdle();
    }

    const inboundSentAtNote = ctx.createTimeMs
      ? `[System: Feishu message create_time=${ctx.createTimeMs} (${new Date(ctx.createTimeMs).toISOString()})]`
      : undefined;
    if (inboundSentAtNote) {
      messageBody = `${inboundSentAtNote}\n\n${messageBody}`;
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      // For the envelope timestamp, prefer Feishu message create_time if present.
      timestamp: ctx.createTimeMs ? new Date(ctx.createTimeMs) : new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = isGroup ? ctx.chatId : undefined;

    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const inboundHistory =
      isGroup && historyKey && historyLimit > 0 && chatHistories
        ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: wantsContinue
        ? `${combinedBody}\n\n[system] 用户请求继续上一条被打断/失败的任务；以下为原始请求内容：\n${originalTextForRun}`
        : combinedBody,
      BodyForAgent: originalTextForRun,
      InboundHistory: inboundHistory,
      RawBody: originalTextForRun,
      CommandBody: originalTextForRun,
      From: feishuFrom,
      To: feishuTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? ctx.chatId : undefined,
      SenderName: ctx.senderName ?? ctx.senderOpenId,
      SenderId: ctx.senderOpenId,
      Provider: "feishu" as const,
      Surface: "feishu" as const,
      MessageSid: ctx.messageId,
      ReplyToBody: quotedContent ?? undefined,
      // Preserve gateway-received timestamp for ordering, but include sent time in the envelope/body note.
      Timestamp: Date.now(),
      WasMentioned: ctx.mentionedBot,
      CommandAuthorized: true,
      OriginatingChannel: "feishu" as const,
      OriginatingTo: feishuTo,
      ...mediaPayload,
    });

    let sawReplyStart = false;

    const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      chatId: ctx.chatId,
      replyToMessageId: anchorMessageId,
      mentionTargets: ctx.mentionTargets,
      accountId: account.accountId,
      statusCallbacks: {
        onReplyStart: async () => {
          sawReplyStart = true;
          await setFeishuStatus({
            cfg,
            runtime,
            stateDir,
            accountId: account.accountId,
            chatId: ctx.chatId,
            chatType: isGroup ? "group" : "direct",
            userOpenId: ctx.senderOpenId,
            messageId: anchorMessageId,
            taskId: inFlightTaskId,
            nextState: "working",
            nextEmojiType: FeishuEmoji.HAMMER,
          });
        },
        onIdle: async () => {
          // Best-effort: if we're still in a working/waiting state, mark DONE and clear.
          try {
            const { filePath, store } = await readFeishuInFlightStore({
              stateDir,
              accountId: account.accountId,
            });
            if (!sawReplyStart) {
              return;
            }
            const task = store.tasks.find((t) => t.id === inFlightTaskId);
            if (!task) return;
            if (["done", "failed", "interrupted"].includes(task.state)) return;
            await setFeishuStatus({
              cfg,
              runtime,
              stateDir,
              accountId: account.accountId,
              chatId: ctx.chatId,
              chatType: isGroup ? "group" : "direct",
              userOpenId: ctx.senderOpenId,
              messageId: anchorMessageId,
              taskId: inFlightTaskId,
              nextState: "done",
              nextEmojiType: FeishuEmoji.DONE,
            });
            const { filePath: fp2, store: st2 } = await readFeishuInFlightStore({
              stateDir,
              accountId: account.accountId,
            });
            await writeFeishuInFlightStore({
              filePath: fp2,
              store: removeTask(st2, inFlightTaskId),
            });
          } catch {
            // ignore
          }
        },
      },
    });

    // Mark queued (we have accepted the work; actual typing will start on reply generation).
    await setFeishuStatus({
      cfg,
      runtime,
      stateDir,
      accountId: account.accountId,
      chatId: ctx.chatId,
      chatType: isGroup ? "group" : "direct",
      userOpenId: ctx.senderOpenId,
      messageId: anchorMessageId,
      taskId: inFlightTaskId,
      nextState: "queued",
      nextEmojiType: FeishuEmoji.ONE_SECOND,
    });

    log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    if (counts.final === 0) {
      if (queuedFinal) {
        await setFeishuStatus({
          cfg,
          runtime,
          stateDir,
          accountId: account.accountId,
          chatId: ctx.chatId,
          chatType: isGroup ? "group" : "direct",
          userOpenId: ctx.senderOpenId,
          messageId: anchorMessageId,
          taskId: inFlightTaskId,
          nextState: "waiting",
          nextEmojiType: FeishuEmoji.ALARM,
        });
      } else {
        await setFeishuStatus({
          cfg,
          runtime,
          stateDir,
          accountId: account.accountId,
          chatId: ctx.chatId,
          chatType: isGroup ? "group" : "direct",
          userOpenId: ctx.senderOpenId,
          messageId: anchorMessageId,
          taskId: inFlightTaskId,
          nextState: "failed",
          nextEmojiType: FeishuEmoji.ERROR,
        });

        // Minimal fallback (B): only when there is no user-visible reply.
        await sendMessageFeishu({
          cfg,
          to: isGroup ? ctx.chatId : ctx.senderOpenId,
          replyToMessageId: anchorMessageId,
          text: "⚠️ 刚刚处理失败（接口校验/权限问题），没能发出结果；你回复“继续”我会按原任务重试。",
          accountId: account.accountId,
        });

        const { filePath, store } = await readFeishuInFlightStore({
          stateDir,
          accountId: account.accountId,
        });
        const nextStore = setLastInterruptible(store, ctx.chatId, inFlightTaskId);
        await writeFeishuInFlightStore({ filePath, store: nextStore });
      }
    }

    if (isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    log(
      `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
    );
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}

async function cleanupTypingReactionsForMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  messageId: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { cfg, accountId, messageId, runtime } = params;
  try {
    const reactions = await listReactionsFeishu({
      cfg,
      accountId,
      messageId,
      emojiType: FeishuEmoji.TYPING,
    });

    for (const r of reactions) {
      // Only remove app-added typing indicators.
      if (r.operatorType !== "app") continue;
      if (!r.reactionId) continue;
      await removeReactionFeishu({ cfg, accountId, messageId, reactionId: r.reactionId });
    }

    if (reactions.length > 0) {
      runtime?.log?.(`feishu[${accountId}]: cleaned up ${reactions.length} typing reactions`);
    }
  } catch (err) {
    runtime?.log?.(`feishu[${accountId}]: typing cleanup failed: ${String(err)}`);
  }
}

export async function reconcileFeishuInFlight(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  maxAgeMs?: number;
}): Promise<void> {
  const { cfg, accountId, runtime } = params;
  const maxAgeMs =
    typeof params.maxAgeMs === "number" ? Math.max(0, params.maxAgeMs) : 24 * 60 * 60 * 1000;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const stateDir = getFeishuRuntime().state.resolveStateDir();
  const { filePath, store } = await readFeishuInFlightStore({ stateDir, accountId });
  const now = Date.now();

  let nextStore = store;

  for (const task of store.tasks) {
    if (task.accountId !== accountId) continue;
    if (task.interruptedHandled) continue;
    if (!["queued", "working", "waiting"].includes(task.state)) continue;
    if (now - task.updatedAtMs > maxAgeMs) continue;

    try {
      // If we were mid-reply when the gateway restarted, the typing indicator reaction can be left behind.
      // Clean it up best-effort so the anchor message does not stay in "typing" forever.
      await cleanupTypingReactionsForMessage({
        cfg,
        accountId,
        messageId: task.messageId,
        runtime,
      });

      // Mark interrupted (⚠️)
      const reaction = await replaceStatusReaction({
        cfg,
        messageId: task.messageId,
        nextEmojiType: FeishuEmoji.ERROR,
        prev: task.reaction
          ? { emojiType: task.reaction.emojiType, reactionId: task.reaction.reactionId }
          : undefined,
        accountId,
        runtime,
      });

      // Must send a single explanation message (user requirement).
      await sendMessageFeishu({
        cfg,
        to: task.chatType === "group" ? task.chatId : (task.userOpenId ?? task.chatId),
        replyToMessageId: task.messageId,
        text: "⚠️ 我刚才在处理你这条消息时服务重启被打断了。你回复“继续”我会按原任务重跑。",
        accountId,
      });

      const updated: FeishuInFlightTask = {
        ...task,
        state: "interrupted",
        reaction: { emojiType: reaction.emojiType, reactionId: reaction.reactionId },
        interruptedHandled: true,
        updatedAtMs: now,
      };

      nextStore = upsertTask(nextStore, updated);
      nextStore = setLastInterruptible(nextStore, task.chatId, task.id);
    } catch (err) {
      error(`feishu[${accountId}]: reconcile inflight failed: ${String(err)}`);
    }
  }

  if (nextStore !== store) {
    await writeFeishuInFlightStore({ filePath, store: nextStore });
    log(`feishu[${accountId}]: inflight reconciliation complete`);
  }
}
