import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchImageAsDataUrl } from './fetch_image_bytes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchImageAsDataUrl', () => {
  it('returns image bytes as a data URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } })
        )
    );

    const outcome = await fetchImageAsDataUrl('https://cdn.example.com/oia.jpg', 1000, 30_000);
    expect(outcome).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,AQID' });
  });

  it('rejects non-http schemes without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const url of ['blob:https://example.com/x', 'file:///tmp/x.jpg', 'data:image/jpeg,xx']) {
      expect(await fetchImageAsDataUrl(url, 1000, 30_000)).toEqual({
        ok: false,
        reason: 'unsupported-scheme',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps transport and content failures to reasons', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockRejectedValueOnce(new TypeError('CORS'));
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000, 30_000)).toEqual({
      ok: false,
      reason: 'fetch-failed',
    });

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000, 30_000)).toEqual({
      ok: false,
      reason: 'http-status',
    });

    fetchMock.mockResolvedValueOnce(
      new Response('text', { headers: { 'content-type': 'text/html' } })
    );
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000, 30_000)).toEqual({
      ok: false,
      reason: 'non-image',
    });

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(100), { headers: { 'content-type': 'image/png' } })
    );
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 10, 30_000)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('bounds a stalled download with the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      )
    );

    const outcome = await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000, 10);
    expect(outcome).toEqual({ ok: false, reason: 'fetch-failed' });
  });

  it('bounds a stall mid-body', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
        init?.signal?.addEventListener('abort', () => {
          streamController.error(new DOMException('aborted', 'AbortError'));
        });

        return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
      })
    );

    const outcome = await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000, 10);
    expect(outcome).toEqual({ ok: false, reason: 'fetch-failed' });
  });
});
