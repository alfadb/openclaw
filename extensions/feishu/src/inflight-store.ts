import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type FeishuInFlightState =
  | "received"
  | "queued"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "interrupted";

export type FeishuInFlightTask = {
  id: string;
  provider: "feishu";
  accountId: string;
  chatId: string;
  chatType: "direct" | "group";
  userOpenId?: string;
  messageId: string;
  originalText: string;
  truncated?: boolean;
  state: FeishuInFlightState;
  reaction?: {
    emojiType: string;
    reactionId: string;
  };
  runId?: string;
  resumeAttempts?: number;
  updatedAtMs: number;
  interruptedHandled?: boolean;
};

export type FeishuInFlightStore = {
  version: 1;
  tasks: FeishuInFlightTask[];
  lastInterruptibleByChatId?: Record<string, string>;
};

const STORE_VERSION = 1 as const;
const STORE_DIR = "feishu/inflight";
const STORE_FILE = "store.json";

export function createInFlightId(): string {
  return crypto.randomUUID();
}

export function clampOriginalText(
  text: string,
  maxChars = 8000,
): { text: string; truncated: boolean } {
  const t = (text ?? "").toString();
  if (t.length <= maxChars) {
    return { text: t, truncated: false };
  }
  return { text: t.slice(0, maxChars), truncated: true };
}

export async function readFeishuInFlightStore(params: {
  stateDir: string;
  accountId: string;
}): Promise<{ filePath: string; store: FeishuInFlightStore }> {
  const { stateDir, accountId } = params;
  const dir = path.join(stateDir, STORE_DIR);
  const filePath = path.join(dir, `${accountId}-${STORE_FILE}`);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<FeishuInFlightStore>;
    const tasks = Array.isArray(parsed.tasks) ? (parsed.tasks as FeishuInFlightTask[]) : [];
    const lastInterruptibleByChatId =
      parsed.lastInterruptibleByChatId && typeof parsed.lastInterruptibleByChatId === "object"
        ? (parsed.lastInterruptibleByChatId as Record<string, string>)
        : undefined;
    return {
      filePath,
      store: {
        version: STORE_VERSION,
        tasks,
        lastInterruptibleByChatId,
      },
    };
  } catch {
    return {
      filePath,
      store: {
        version: STORE_VERSION,
        tasks: [],
        lastInterruptibleByChatId: {},
      },
    };
  }
}

export async function writeFeishuInFlightStore(params: {
  filePath: string;
  store: FeishuInFlightStore;
}): Promise<void> {
  const { filePath, store } = params;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, filePath);
}

export function upsertTask(
  store: FeishuInFlightStore,
  task: FeishuInFlightTask,
): FeishuInFlightStore {
  const tasks = [...store.tasks];
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) {
    tasks[idx] = task;
  } else {
    tasks.push(task);
  }
  return { ...store, tasks };
}

export function removeTask(store: FeishuInFlightStore, taskId: string): FeishuInFlightStore {
  return { ...store, tasks: store.tasks.filter((t) => t.id !== taskId) };
}

export function setLastInterruptible(store: FeishuInFlightStore, chatId: string, taskId: string) {
  return {
    ...store,
    lastInterruptibleByChatId: {
      ...(store.lastInterruptibleByChatId ?? {}),
      [chatId]: taskId,
    },
  };
}

export function getLastInterruptibleTask(
  store: FeishuInFlightStore,
  chatId: string,
): FeishuInFlightTask | undefined {
  const id = store.lastInterruptibleByChatId?.[chatId];
  if (!id) return undefined;
  return store.tasks.find((t) => t.id === id);
}
