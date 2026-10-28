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

    const outcome = await fetchImageAsDataUrl('https://cdn.example.com/oia.jpg', 1000);
    expect(outcome).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,AQID' });
  });

  it('rejects non-http schemes without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const url of ['blob:https://example.com/x', 'file:///tmp/x.jpg', 'data:image/jpeg,xx']) {
      expect(await fetchImageAsDataUrl(url, 1000)).toEqual({
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
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000)).toEqual({
      ok: false,
      reason: 'fetch-failed',
    });

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000)).toEqual({
      ok: false,
      reason: 'http-status',
    });

    fetchMock.mockResolvedValueOnce(
      new Response('text', { headers: { 'content-type': 'text/html' } })
    );
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 1000)).toEqual({
      ok: false,
      reason: 'non-image',
    });

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(100), { headers: { 'content-type': 'image/png' } })
    );
    expect(await fetchImageAsDataUrl('https://cdn.example.com/a.jpg', 10)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });
});
