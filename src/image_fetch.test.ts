import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FETCH_JPEG_QUALITY,
  FETCH_MAX_BYTES,
  downscaleToJpegDataUrl,
  encodeBase64,
  fetchImageBytes,
} from './image_fetch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('encodeBase64', () => {
  it('round-trips bytes through the chunked path', () => {
    const proto = Uint8Array.prototype as unknown as { toBase64?: unknown };
    const native = proto.toBase64;
    delete proto.toBase64;
    try {
      const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);
      const decoded = Uint8Array.from(atob(encodeBase64(bytes)), (ch) => ch.charCodeAt(0));
      expect(decoded).toEqual(bytes);
    } finally {
      if (native !== undefined) {
        proto.toBase64 = native;
      }
    }
  });
});

describe('fetchImageBytes', () => {
  it('fetches with credentials omitted and rejects failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = await fetchImageBytes(
      'https://cdn.example.com/oia.jpg',
      new AbortController().signal,
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('omit');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(
      fetchImageBytes('https://cdn.example.com/missing.jpg', new AbortController().signal),
    ).rejects.toThrow('status 404');
  });

  it('caps fetched bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(FETCH_MAX_BYTES + 1)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchImageBytes('https://cdn.example.com/huge.jpg', new AbortController().signal),
    ).rejects.toThrow('size cap');
  });
});

describe('downscaleToJpegDataUrl', () => {
  it('downscales the long side and encodes bounded JPEG', async () => {
    const drawImage = vi.fn();
    const convertToBlob = vi.fn().mockResolvedValue(new Blob(['fakejpeg']));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({
        width: 1600,
        height: 800,
        close: vi.fn(),
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown, width: number, height: number) {
        return { width, height, getContext: () => ({ drawImage }), convertToBlob };
      }),
    );
    const url = await downscaleToJpegDataUrl(new Uint8Array([1, 2, 3]));
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 640);
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: FETCH_JPEG_QUALITY });
  });

  it('keeps small images at native size', async () => {
    const drawImage = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({
        width: 400,
        height: 300,
        close: vi.fn(),
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return { getContext: () => ({ drawImage }), convertToBlob: async () => new Blob(['x']) };
      }),
    );
    await downscaleToJpegDataUrl(new Uint8Array([1]));
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 400, 300);
  });
});
