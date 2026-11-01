// Self-contained: injected modules cannot import shared code.
export type FetchImageReason =
  'unsupported-scheme' | 'fetch-failed' | 'http-status' | 'non-image' | 'too-large' | 'empty';

export type FetchImageOutcome =
  { ok: true; dataUrl: string } | { ok: false; reason: FetchImageReason };

export const fetchImageAsDataUrl = async (
  url: string,
  maxBytes: number,
  timeoutMs: number
): Promise<FetchImageOutcome> => {
  // Defined inside: only this function's own source survives serialization
  // into the page, so outer helpers would be missing there.
  const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';

    const CHUNK = 0x8000;

    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }

    return btoa(binary);
  };

  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return { ok: false, reason: 'unsupported-scheme' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;

    try {
      res = await fetch(url, { credentials: 'omit', signal: controller.signal });
    } catch {
      return { ok: false, reason: 'fetch-failed' };
    }

    if (!res.ok) {
      return { ok: false, reason: 'http-status' };
    }

    const contentType = res.headers.get('content-type') ?? '';

    if (!contentType.startsWith('image/')) {
      return { ok: false, reason: 'non-image' };
    }

    if (!res.body) {
      return { ok: false, reason: 'empty' };
    }

    const reader = res.body.getReader();

    const chunks: Uint8Array[] = [];

    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }
        total += value.byteLength;

        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);

          return { ok: false, reason: 'too-large' };
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);

      return { ok: false, reason: 'fetch-failed' };
    }

    if (total === 0) {
      return { ok: false, reason: 'empty' };
    }

    const bytes = new Uint8Array(total);

    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const mime = contentType.split(';')[0].trim() || 'image/jpeg';

    return { ok: true, dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}` };
  } finally {
    clearTimeout(timer);
  }
};
