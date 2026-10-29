import type { PlaceResult } from './types';
import { sendCommand } from './storage_client';

export interface BoardPin {
  place: PlaceResult;
  sourceHost: string;
  thumbnail?: string;
  imageUrl?: string;
  addedAt: number;
}

export const BOARD_STORAGE_KEY = 'tripBoard';

export const BOARD_CAP = 24;

export const ITINERARY_STORAGE_KEY = 'tripItinerary';

export interface StoredItinerary {
  pinIds: string[];
  markdown: string;
  plannedAt: number;
}

const BOARD_VERSION = 1;

interface BoardRecord {
  v: number;
  pins: unknown;
}

export const THUMB_MAX_SIDE = 512;

export const THUMB_MAX_BYTES = 64000;

export const THUMB_MAX_SOURCE_BYTES = 4000000;

const normalizePart = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\0-\x1F\x7F|]+/g, '');

export const dedupeKeyFor = async (placeName: string, country: string): Promise<string> => {
  const name = normalizePart(placeName);

  const land = normalizePart(country);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${name.length}:${name}|${land.length}:${land}`)
  );

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const isPin = (value: unknown): value is BoardPin => {
  const pin = value as BoardPin | null;

  return (
    !!pin &&
    typeof pin === 'object' &&
    !!pin.place &&
    typeof pin.place.placeName === 'string' &&
    typeof pin.place.country === 'string' &&
    typeof pin.sourceHost === 'string' &&
    typeof pin.addedAt === 'number'
  );
};

const partitionPins = (entries: unknown): { pins: BoardPin[]; carried: unknown[] } => {
  if (!Array.isArray(entries)) {
    return { pins: [], carried: [] };
  }

  const pins: BoardPin[] = [];

  const carried: unknown[] = [];

  for (const entry of entries) {
    if (isPin(entry)) {
      pins.push(entry);
    } else {
      carried.push(entry);
    }
  }

  pins.sort((a, b) => a.addedAt - b.addedAt);

  return { pins, carried };
};

// Strict read for writers: storage failures throw so callers abort instead
// of persisting a board derived from an empty read. Legacy bare arrays
// migrate on the next write; unknown versions refuse the write. Entries
// that are not pins ride along verbatim so no writer erases what it
// cannot parse. Exported for the worker storage service, the only writer.
export const readBoard = async (): Promise<{
  pins: BoardPin[];
  carried: unknown[];
  writable: boolean;
}> => {
  const stored = (await chrome.storage.local.get(BOARD_STORAGE_KEY)) as Record<string, unknown>;

  const record: unknown = stored[BOARD_STORAGE_KEY];

  if (record === undefined) {
    return { pins: [], carried: [], writable: true };
  }

  if (Array.isArray(record)) {
    const { pins, carried } = partitionPins(record);

    return { pins, carried, writable: true };
  }

  if (
    typeof record === 'object' &&
    record !== null &&
    (record as BoardRecord).v === BOARD_VERSION
  ) {
    const { pins, carried } = partitionPins((record as BoardRecord).pins);

    return { pins, carried, writable: true };
  }

  return { pins: [], carried: [], writable: false };
};

// Idempotent: wraps a legacy bare array in the versioned record. Anything
// else (versioned, absent, unwritable) is left for the normal read path.
// Remote image URLs shrink to the stored thumbnail whenever one exists;
// entries that are not pins are carried into the record verbatim, never
// erased to make the migration succeed.
export const migrateBoard = async (): Promise<void> => {
  const stored = (await chrome.storage.local.get(BOARD_STORAGE_KEY)) as Record<string, unknown>;

  const record: unknown = stored[BOARD_STORAGE_KEY];

  if (!Array.isArray(record)) {
    return;
  }

  const { pins, carried } = partitionPins(record);

  const minimized = pins.map((pin) => {
    if (!pin.imageUrl || pin.imageUrl.startsWith('data:')) {
      return pin;
    }

    if (pin.thumbnail) {
      const { imageUrl: _dropped, ...kept } = pin;

      return kept;
    }

    return { ...pin, imageUrl: stripUrlEphemera(pin.imageUrl) };
  });

  await writeBoard([...minimized, ...carried]);
};

export const listPins = async (): Promise<BoardPin[]> => {
  try {
    return (await readBoard()).pins;
  } catch {
    return [];
  }
};

export const writeBoard = async (entries: unknown[]): Promise<void> => {
  const record: BoardRecord = { v: BOARD_VERSION, pins: entries };
  await chrome.storage.local.set({ [BOARD_STORAGE_KEY]: record });
};

export type PinOutcome =
  | { status: 'pinned'; pins: BoardPin[] }
  | { status: 'duplicate'; pins: BoardPin[] }
  | { status: 'full'; pins: BoardPin[] };

export const stripUrlEphemera = (url: string): string => {
  if (url.startsWith('data:')) {
    return url;
  }

  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString();
  } catch {
    return url;
  }
};

export const pinPlace = async (
  pin: Omit<BoardPin, 'addedAt'> & { addedAt?: number }
): Promise<PinOutcome> => sendCommand<PinOutcome>({ kind: 'board.add', pin });

export const removePin = async (
  placeName: string,
  country: string
): Promise<{ pins: BoardPin[]; removed: BoardPin | null }> =>
  sendCommand<{ pins: BoardPin[]; removed: BoardPin | null }>({
    kind: 'board.remove',
    placeName,
    country,
  });

export const movePin = async (
  placeName: string,
  country: string,
  direction: 'up' | 'down'
): Promise<BoardPin[]> =>
  sendCommand<BoardPin[]>({ kind: 'board.move', placeName, country, direction });

export const clearBoard = async (): Promise<void> => {
  await sendCommand<void>({ kind: 'board.clear' });
};

export const saveItinerary = async (pinIds: string[], markdown: string): Promise<void> => {
  await sendCommand<void>({ kind: 'itinerary.save', pinIds, markdown });
};

export const loadItinerary = async (): Promise<StoredItinerary | null> => {
  let record: unknown;

  try {
    const stored = (await chrome.storage.local.get(ITINERARY_STORAGE_KEY)) as Record<
      string,
      unknown
    >;
    record = stored[ITINERARY_STORAGE_KEY];
  } catch {
    return null;
  }

  if (typeof record !== 'object' || record === null) {
    return null;
  }

  const { v, pinIds, markdown, plannedAt } = record as Record<string, unknown>;

  if (
    v !== 1 ||
    !Array.isArray(pinIds) ||
    !pinIds.every((id): id is string => typeof id === 'string') ||
    typeof markdown !== 'string' ||
    typeof plannedAt !== 'number'
  ) {
    return null;
  }

  return { pinIds, markdown, plannedAt };
};

export type ItineraryStatus = 'fresh' | 'stale' | 'none';

export const pinIdentity = async (pins: BoardPin[]): Promise<string[]> =>
  Promise.all(pins.map((pin) => dedupeKeyFor(pin.place.placeName, pin.place.country)));

export const itineraryStatus = async (
  pins: BoardPin[],
  stored: StoredItinerary | null
): Promise<ItineraryStatus> => {
  if (!stored) {
    return 'none';
  }

  const current = await pinIdentity(pins);

  return current.length === stored.pinIds.length &&
    current.every((id, index) => id === stored.pinIds[index])
    ? 'fresh'
    : 'stale';
};

const decodeImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('thumbnail decode failed'));
    img.src = dataUrl;
  });

// Pixel thumbnails from legitimately held bytes (data: images, captured
// frames) only: callers must never pass a remote URL here, since drawing a
// cross-origin image taints the canvas and readback fails closed to null.
// Descending quality ladder to the byte cap; null when nothing fits.
export const makeThumbnail = async (
  dataUrl: string,
  maxSide: number = THUMB_MAX_SIDE,
  maxBytes: number = THUMB_MAX_BYTES
): Promise<string | null> => {
  if (!dataUrl.startsWith('data:image/') || dataUrl.length > THUMB_MAX_SOURCE_BYTES) {
    return null;
  }

  let img: HTMLImageElement;

  try {
    img = await decodeImage(dataUrl);
  } catch {
    return null;
  }

  if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) {
    return null;
  }

  const canvas = document.createElement('canvas');

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return null;
  }

  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));

  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }

  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    let out = '';

    try {
      out = canvas.toDataURL('image/jpeg', quality);
    } catch {
      return null;
    }

    if (out.length <= maxBytes) {
      return out;
    }
  }

  return null;
};
