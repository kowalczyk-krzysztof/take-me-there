// One session slot per window, sequence-ordered; timestamps only expire.
import * as z from 'zod/mini';
import { createMutex } from './utils/mutex';
import { isExtensionPageSender } from './storage_commands';

export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export const HANDOFF_SEQ_KEY = 'handoffSeq';

export const HANDOFF_ACK_SCOPE = 'take-me-there/handoff-v1';

const ACK_TIMEOUT_MS = 5000;

export const handoffSlotKey = (windowId: number): string => `tripRequest:${windowId}`;

// Serializes slot check-and-act so an ack can never delete a newer payload. Worker-side only.
const slotMutex = createMutex();

export const withHandoffSlot = <T>(task: () => Promise<T>): Promise<T> => slotMutex(task);

const ackSchema = z.strictObject({
  windowId: z.number(),
  seq: z.number(),
});

// Concurrent clicks serialize here so every sequence is unique; the chain rehydrates from storage after a restart.
let seqTail: Promise<number> | null = null;

const loadSeq = async (): Promise<number> => {
  try {
    const stored = (await chrome.storage.session.get(HANDOFF_SEQ_KEY)) as Record<string, unknown>;

    const value = stored[HANDOFF_SEQ_KEY];

    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
};

export const allocateHandoffSeq = (): Promise<number> => {
  if (!seqTail) {
    seqTail = loadSeq();
  }

  const issued = seqTail.then(async (current) => {
    const next = current + 1;
    await chrome.storage.session.set({ [HANDOFF_SEQ_KEY]: next });

    return next;
  });

  // A persist failure rejects this caller but never poisons the chain.
  seqTail = issued.catch(() => loadSeq());

  return issued;
};

// Clears the slot only on sequence match.
export const ackHandoffSlot = async (windowId: number, seq: number): Promise<boolean> => {
  const slot = handoffSlotKey(windowId);

  const stored = (await chrome.storage.session.get(slot)) as Record<string, unknown>;

  const record = stored[slot] as { seq?: unknown } | undefined;

  if (!record || record.seq !== seq) {
    return false;
  }

  await chrome.storage.session.remove(slot);

  return true;
};

export interface HandoffAckResult {
  ok: boolean;
  cleared?: boolean;
  error?: string;
}

// Returns undefined for foreign messages.
export const handleHandoffMessage = async (
  message: unknown,
  sender: chrome.runtime.MessageSender
): Promise<HandoffAckResult | undefined> => {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const envelope = message as { scope?: unknown; windowId?: unknown; seq?: unknown };

  if (envelope.scope !== HANDOFF_ACK_SCOPE) {
    return undefined;
  }

  if (!isExtensionPageSender(sender)) {
    return { ok: false, error: 'rejected sender' };
  }

  const parsed = ackSchema.safeParse({ windowId: envelope.windowId, seq: envelope.seq });

  if (!parsed.success) {
    return { ok: false, error: 'invalid payload' };
  }

  try {
    const cleared = await withHandoffSlot(() =>
      ackHandoffSlot(parsed.data.windowId, parsed.data.seq)
    );

    return { ok: true, cleared };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'ack failed' };
  }
};

// Best-effort consume: a failed ack leaves the slot for TTL expiry rather
// than stalling the run behind worker messaging.
export const ackRequest = async (windowId: number, seq: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('ack timed out')), ACK_TIMEOUT_MS);
    });

    await Promise.race([
      chrome.runtime.sendMessage({ scope: HANDOFF_ACK_SCOPE, windowId, seq }),
      timeout,
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
  }
};
