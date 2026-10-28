import { fetchImageAsDataUrl } from './injected/fetch_image_bytes';
import { fetchTimeout } from './providers/index';

export const FETCH_MAX_BYTES = 10000000;

export const dataUrlToBytes = (dataUrl: string): Uint8Array | null => {
  const marker = ';base64,';

  const at = dataUrl.indexOf(marker);

  if (!dataUrl.startsWith('data:image/') || at < 0) {
    return null;
  }

  try {
    const binary = atob(dataUrl.slice(at + marker.length));

    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
};

export const FETCH_MAX_SIDE = 1280;

export const FETCH_JPEG_QUALITY = 0.85;

export const fetchImageBytes = async (url: string, signal: AbortSignal): Promise<Uint8Array> => {
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new Error('refusing to fetch a non-http image URL');
  }

  const res = await fetch(url, { credentials: 'omit', signal: fetchTimeout(signal) });

  if (!res.ok) {
    throw new Error(`image fetch failed with status ${res.status}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  if (!contentType.startsWith('image/')) {
    throw new Error(`refusing to decode non-image content (${contentType || 'unknown type'})`);
  }

  if (!res.body) {
    throw new Error('image fetch returned no body');
  }

  const reader = res.body.getReader();

  const chunks: Uint8Array[] = [];

  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }
    total += value.byteLength;

    if (total > FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);

      throw new Error('image exceeds the fetch size cap');
    }
    chunks.push(value);
  }

  if (total === 0) {
    throw new Error('image fetch returned no bytes');
  }

  const bytes = new Uint8Array(total);

  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

// Page-context byte fetch: runs inside the target tab, so CORS-open image
// hosts need no extension permission and the user sees no grant prompt.
// Anything the tab cannot do (navigated away, unscriptable page, CORS
// rejection, undecodable result) throws and the caller falls back to the
// permission-gated direct fetch.
export const fetchImageBytesViaTab = async (
  tabId: number,
  frameId: number,
  url: string,
  signal: AbortSignal
): Promise<Uint8Array> => {
  const outcome = await runWithSignal(signal, () =>
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: fetchImageAsDataUrl as unknown as (...args: never[]) => unknown,
      args: [url, FETCH_MAX_BYTES],
    })
  );

  const result = outcome[0]?.result as
    { ok: boolean; dataUrl?: unknown; reason?: unknown } | null | undefined;

  if (!result || result.ok !== true || typeof result.dataUrl !== 'string') {
    throw new Error(
      `tab image fetch failed (${typeof result?.reason === 'string' ? result.reason : 'no result'})`
    );
  }

  const bytes = dataUrlToBytes(result.dataUrl);

  if (!bytes) {
    throw new Error('tab image fetch returned undecodable bytes');
  }

  return bytes;
};

const runWithSignal = async <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> => {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('tab fetch aborted');
  }

  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('tab fetch aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
};

export const downscaleToJpegDataUrl = async (bytes: Uint8Array): Promise<string> => {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));

  try {
    const scale = Math.min(1, FETCH_MAX_SIDE / Math.max(bitmap.width, bitmap.height));

    const width = Math.max(1, Math.round(bitmap.width * scale));

    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);

    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('2d canvas context unavailable');
    }

    ctx.drawImage(bitmap, 0, 0, width, height);

    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: FETCH_JPEG_QUALITY });

    const out = new Uint8Array(await jpeg.arrayBuffer());

    if (out.length === 0) {
      throw new Error('JPEG encoding returned no bytes');
    }

    return `data:image/jpeg;base64,${encodeBase64(out)}`;
  } finally {
    bitmap.close();
  }
};

export const encodeBase64 = (bytes: Uint8Array): string => {
  const toBase64 = (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64;

  if (typeof toBase64 === 'function') {
    return (toBase64 as (this: Uint8Array) => string).call(bytes);
  }

  let binary = '';

  const CHUNK = 0x8000;

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return btoa(binary);
};
