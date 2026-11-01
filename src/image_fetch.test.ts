import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FETCH_JPEG_QUALITY,
  FETCH_MAX_BYTES,
  IMAGE_TAB_TIMEOUT_MS,
  downscaleToJpegDataUrl,
  fetchImageBytes,
  fetchImageBytesViaTab,
} from './image_fetch';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchImageBytesViaTab', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  const signal = () => new AbortController().signal;

  it('decodes tab-fetched bytes and targets the click frame', async () => {
    mock.worker.scriptingImpl = async () => [
      { result: { ok: true, dataUrl: 'data:image/jpeg;base64,AQID' } },
    ];

    const bytes = await fetchImageBytesViaTab(7, 3, 'https://cdn.example.com/oia.jpg', signal());
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(mock.worker.scriptingCalls).toHaveLength(1);
    expect(mock.worker.scriptingCalls[0].target).toEqual({ tabId: 7, frameIds: [3] });
    expect(mock.worker.scriptingCalls[0].args).toEqual([
      'https://cdn.example.com/oia.jpg',
      FETCH_MAX_BYTES,
      IMAGE_TAB_TIMEOUT_MS,
    ]);
  });

  it('throws on tab failures so callers fall back', async () => {
    mock.worker.scriptingImpl = async () => [{ result: null }];
    await expect(
      fetchImageBytesViaTab(7, 0, 'https://cdn.example.com/a.jpg', signal())
    ).rejects.toThrow('no result');

    mock.worker.scriptingImpl = async () => [{ result: { ok: false, reason: 'fetch-failed' } }];
    await expect(
      fetchImageBytesViaTab(7, 0, 'https://cdn.example.com/a.jpg', signal())
    ).rejects.toThrow('fetch-failed');

    mock.worker.scriptingImpl = async () => [{ result: { ok: true, dataUrl: 'garbage' } }];
    await expect(
      fetchImageBytesViaTab(7, 0, 'https://cdn.example.com/a.jpg', signal())
    ).rejects.toThrow('undecodable');
  });

  it('throws without scripting when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchImageBytesViaTab(7, 0, 'https://cdn.example.com/a.jpg', controller.signal)
    ).rejects.toThrow();
    expect(mock.worker.scriptingCalls).toHaveLength(0);
  });
});

describe('fetchImageBytes', () => {
  it('fetches with credentials omitted and rejects failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
      );
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await fetchImageBytes(
      'https://cdn.example.com/oia.jpg',
      new AbortController().signal
    );
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('omit');
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(
      fetchImageBytes('https://cdn.example.com/missing.jpg', new AbortController().signal)
    ).rejects.toThrow('status 404');
  });

  it('caps fetched bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(FETCH_MAX_BYTES + 1), {
        headers: { 'content-type': 'image/jpeg' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchImageBytes('https://cdn.example.com/huge.jpg', new AbortController().signal)
    ).rejects.toThrow('size cap');
  });

  it('refuses non-http URLs without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const url of [
      'file:///etc/passwd',
      'chrome://extensions',
      'data:image/jpeg;base64,AAAA',
      'blob:https://example.com/uuid',
    ]) {
      await expect(fetchImageBytes(url, new AbortController().signal)).rejects.toThrow('non-http');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses non-image content without decoding', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchImageBytes('https://example.com/page', new AbortController().signal)
    ).rejects.toThrow('non-image');
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
      })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown, width: number, height: number) {
        return { width, height, getContext: () => ({ drawImage }), convertToBlob };
      })
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
      })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown) {
        return { getContext: () => ({ drawImage }), convertToBlob: async () => new Blob(['x']) };
      })
    );
    await downscaleToJpegDataUrl(new Uint8Array([1]));
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 400, 300);
  });
});
