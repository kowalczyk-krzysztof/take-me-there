// Trip board persistence (D1): pinned places live in storage.local with
// thumbnails at rest. Dedupe by hashed (placeName, country) tuple with
// length-prefixed components (a pipe in a name cannot collide); FIFO
// eviction at the cap; storage failures throw so the panel can surface the
// no-thumbnail retry instead of lying about the pin.
import type { PlaceResult } from './types';

export interface BoardPin {
  place: PlaceResult;
  sourceHost: string;
  thumbnail?: string;
  imageUrl?: string;
  addedAt: number;
}

export const BOARD_STORAGE_KEY = 'tripBoard';
export const BOARD_CAP = 24;
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
    new TextEncoder().encode(`${name.length}:${name}|${land.length}:${land}`),
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

export const listPins = async (): Promise<BoardPin[]> => {
  try {
    const stored = (await chrome.storage.local.get(BOARD_STORAGE_KEY)) as Record<string, unknown>;
    const pins = stored[BOARD_STORAGE_KEY];
    if (!Array.isArray(pins)) {
      return [];
    }
    return pins.filter(isPin).sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
};

export type PinOutcome =
  | { status: 'pinned'; pins: BoardPin[]; evicted: BoardPin | null }
  | { status: 'duplicate'; pins: BoardPin[] };

export const pinPlace = async (
  pin: Omit<BoardPin, 'addedAt'> & { addedAt?: number },
): Promise<PinOutcome> => {
  const pins = await listPins();
  const key = await dedupeKeyFor(pin.place.placeName, pin.place.country);
  const keys = await Promise.all(
    pins.map((entry) => dedupeKeyFor(entry.place.placeName, entry.place.country)),
  );
  if (keys.includes(key)) {
    return { status: 'duplicate', pins };
  }
  const entry: BoardPin = { ...pin, addedAt: pin.addedAt ?? Date.now() };
  const next = [...pins, entry].sort((a, b) => a.addedAt - b.addedAt);
  let evicted: BoardPin | null = null;
  if (next.length > BOARD_CAP) {
    evicted = next.shift() ?? null;
  }
  await chrome.storage.local.set({ [BOARD_STORAGE_KEY]: next });
  return { status: 'pinned', pins: next, evicted };
};

export const removePin = async (placeName: string, country: string): Promise<BoardPin[]> => {
  const pins = await listPins();
  const key = await dedupeKeyFor(placeName, country);
  const keys = await Promise.all(
    pins.map((entry) => dedupeKeyFor(entry.place.placeName, entry.place.country)),
  );
  const next = pins.filter((_, index) => keys[index] !== key);
  if (next.length !== pins.length) {
    await chrome.storage.local.set({ [BOARD_STORAGE_KEY]: next });
  }
  return next;
};

export const clearBoard = async (): Promise<void> => {
  await chrome.storage.local.remove(BOARD_STORAGE_KEY);
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
  maxBytes: number = THUMB_MAX_BYTES,
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
