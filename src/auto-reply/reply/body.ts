import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { setAbortMemory } from "./abort.js";

export async function applySessionHints(params: {
  baseBody: string;
  abortedLastRun: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  abortKey?: string;
}): Promise<string> {
  let prefixedBodyBase = params.baseBody;
  const abortedHint = params.abortedLastRun
    ? "Note: The previous agent run was aborted by the user. Resume carefully or ask for clarification."
    : "";
  if (abortedHint) {
    prefixedBodyBase = `${abortedHint}\n\n${prefixedBodyBase}`;
    if (params.sessionEntry && params.sessionStore && params.sessionKey) {
      params.sessionEntry.abortedLastRun = false;
      params.sessionEntry.updatedAt = Date.now();
      params.sessionStore[params.sessionKey] = params.sessionEntry;
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        await updateSessionStore(params.storePath, (store) => {
          const entry = store[sessionKey] ?? params.sessionEntry;
          if (!entry) {
            return;
          }
          store[sessionKey] = {
            ...entry,
            abortedLastRun: false,
            updatedAt: Date.now(),
          };
        });
      }
    } else if (params.abortKey) {
      setAbortMemory(params.abortKey, false);
    }
  }

  const recovered = params.sessionEntry?.recoveredFromUnhealthy;
  const recoveredReason = params.sessionEntry?.recoveredFromUnhealthyReason;
  if (recovered) {
    const hint =
      "Note: The previous session became unhealthy (likely context overflow). " +
      "A fresh session was started automatically; you may need to re-run the last request.";
    const reasonHint = recoveredReason ? ` (reason: ${recoveredReason})` : "";
    prefixedBodyBase = `${hint}${reasonHint}\n\n${prefixedBodyBase}`;

    if (params.sessionEntry && params.sessionStore && params.sessionKey) {
      params.sessionEntry.recoveredFromUnhealthy = false;
      params.sessionEntry.recoveredFromUnhealthyReason = undefined;
      params.sessionEntry.updatedAt = Date.now();
      params.sessionStore[params.sessionKey] = params.sessionEntry;
      if (params.storePath) {
        const sessionKey = params.sessionKey;
        await updateSessionStore(params.storePath, (store) => {
          const entry = store[sessionKey] ?? params.sessionEntry;
          if (!entry) {
            return;
          }
          store[sessionKey] = {
            ...entry,
            recoveredFromUnhealthy: false,
            recoveredFromUnhealthyReason: undefined,
            updatedAt: Date.now(),
          };
        });
      }
    }
  }
  return prefixedBodyBase;
}
