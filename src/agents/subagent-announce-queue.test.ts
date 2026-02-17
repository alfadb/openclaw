import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueAnnounce, resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("subagent-announce-queue", () => {
  afterEach(() => {
    resetAnnounceQueuesForTests();
  });

  it("drops stale non-priority announce items", async () => {
    const send = vi.fn(async () => {});
    const key = `stale-${Date.now()}`;

    enqueueAnnounce({
      key,
      send,
      settings: { mode: "followup", debounceMs: 0, maxAgeMs: 10 },
      item: {
        prompt: "stale",
        sessionKey: "agent:main:main",
        enqueuedAt: Date.now() - 60_000,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("allows stale high-priority announce items to bypass stale gate", async () => {
    const send = vi.fn(async () => {});
    const key = `high-priority-${Date.now()}`;

    enqueueAnnounce({
      key,
      send,
      settings: { mode: "followup", debounceMs: 0, maxAgeMs: 10 },
      item: {
        prompt: "important",
        sessionKey: "agent:main:main",
        enqueuedAt: Date.now() - 60_000,
        highPriority: true,
      },
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("drops stale items during collect mode while keeping fresh entries", async () => {
    const send = vi.fn(async () => {});
    const key = `collect-stale-${Date.now()}`;

    enqueueAnnounce({
      key,
      send,
      settings: { mode: "collect", debounceMs: 0, maxAgeMs: 50 },
      item: {
        prompt: "stale item",
        sessionKey: "agent:main:main",
        enqueuedAt: Date.now() - 10_000,
      },
    });

    enqueueAnnounce({
      key,
      send,
      settings: { mode: "collect", debounceMs: 0, maxAgeMs: 50 },
      item: {
        prompt: "fresh item",
        sessionKey: "agent:main:main",
        enqueuedAt: Date.now(),
      },
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    expect(send.mock.calls[0]?.[0]?.prompt).toContain("fresh item");
    expect(send.mock.calls[0]?.[0]?.prompt).not.toContain("stale item");
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sendPrompts: string[] = [];
    let attempts = 0;
    const send = vi.fn(async (item: { prompt: string }) => {
      attempts += 1;
      sendPrompts.push(item.prompt);
      if (attempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
    });

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
    });

    await waitFor(() => attempts >= 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sendPrompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sendPrompts: string[] = [];
    let attempts = 0;
    const send = vi.fn(async (item: { prompt: string }) => {
      attempts += 1;
      sendPrompts.push(item.prompt);
      if (attempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
    });

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });

    await waitFor(() => attempts >= 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sendPrompts[0]).toContain("[Queue overflow]");
    expect(sendPrompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sendPrompts: string[] = [];
    let attempts = 0;
    const send = vi.fn(async (item: { prompt: string }) => {
      attempts += 1;
      sendPrompts.push(item.prompt);
      if (attempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
    });

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });

    await waitFor(() => attempts >= 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sendPrompts[0]).toContain("Queued #1");
    expect(sendPrompts[0]).toContain("queued item one");
    expect(sendPrompts[0]).toContain("Queued #2");
    expect(sendPrompts[0]).toContain("queued item two");
    expect(sendPrompts[1]).toContain("Queued #1");
    expect(sendPrompts[1]).toContain("queued item one");
    expect(sendPrompts[1]).toContain("Queued #2");
    expect(sendPrompts[1]).toContain("queued item two");
  });
});
