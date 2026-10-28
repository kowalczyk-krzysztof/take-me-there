import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureVideoFrame } from './capture_video_frame';

const PAGE_URL = 'https://example.com/travel/vlog';

const setPageUrl = (url: string): void => {
  const w = window as unknown as { happyDOM?: { setURL: (url: string) => void } };
  w.happyDOM?.setURL(url);
};

interface VideoStubs {
  currentSrc: string;
  src?: string;
  paused?: boolean;
  ended?: boolean;
  readyState?: number;
  videoWidth?: number;
  videoHeight?: number;
  currentTime?: number;
  mediaKeys?: unknown;
}

const addVideo = (stubs: VideoStubs): HTMLVideoElement => {
  const video = document.createElement('video');
  document.body.append(video);
  Object.defineProperty(video, 'currentSrc', { value: stubs.currentSrc, configurable: true });

  if (stubs.src !== undefined) {
    Object.defineProperty(video, 'src', { value: stubs.src, configurable: true });
  }
  Object.defineProperty(video, 'paused', { value: stubs.paused ?? false, configurable: true });
  Object.defineProperty(video, 'ended', { value: stubs.ended ?? false, configurable: true });
  Object.defineProperty(video, 'readyState', { value: stubs.readyState ?? 4, configurable: true });
  Object.defineProperty(video, 'videoWidth', {
    value: stubs.videoWidth ?? 1280,
    configurable: true,
  });
  Object.defineProperty(video, 'videoHeight', {
    value: stubs.videoHeight ?? 720,
    configurable: true,
  });
  Object.defineProperty(video, 'currentTime', {
    value: stubs.currentTime ?? 12.5,
    configurable: true,
  });
  Object.defineProperty(video, 'mediaKeys', {
    value: stubs.mediaKeys ?? null,
    configurable: true,
  });

  return video;
};

const drawImage = vi.fn();

const toDataURL = vi.fn((_type: string, _quality: number): string => 'data:image/jpeg,small');

beforeEach(() => {
  setPageUrl(PAGE_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  drawImage.mockClear();
  toDataURL.mockClear();
  toDataURL.mockImplementation(
    (_type: string, _quality: number): string => 'data:image/jpeg,small'
  );
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL =
    toDataURL as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('captureVideoFrame', () => {
  it('captures the video matching currentSrc, with time and dimensions', () => {
    addVideo({ currentSrc: 'blob:https://example.com/aaa' });

    const out = captureVideoFrame('blob:https://example.com/aaa');

    expect(out).toMatchObject({ ok: true, time: 12.5, width: 1280, height: 720 });
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('matches the src attribute when currentSrc is empty', () => {
    addVideo({ currentSrc: '', src: 'https://cdn.example.com/trip.mp4' });

    const out = captureVideoFrame('https://cdn.example.com/trip.mp4');

    expect(out.ok).toBe(true);
  });

  it('matches with the query string stripped on either side', () => {
    addVideo({ currentSrc: 'https://cdn.example.com/trip.mp4?sig=new' });

    const out = captureVideoFrame('https://cdn.example.com/trip.mp4?sig=old');

    expect(out.ok).toBe(true);
  });

  it('falls back to the only playing video when nothing matches', () => {
    addVideo({
      currentSrc: 'blob:https://example.com/other',
      paused: true,
      readyState: 1,
    });
    addVideo({ currentSrc: 'blob:https://example.com/playing' });

    const out = captureVideoFrame('blob:https://example.com/gone');

    expect(out.ok).toBe(true);
  });

  it('refuses to guess between two playing videos', () => {
    addVideo({ currentSrc: 'blob:https://example.com/one' });
    addVideo({ currentSrc: 'blob:https://example.com/two' });

    const out = captureVideoFrame('blob:https://example.com/gone');

    expect(out).toEqual({ ok: false, reason: 'no-match' });
  });

  it('reports no-match when no video is playing', () => {
    addVideo({ currentSrc: 'blob:https://example.com/one', paused: true });

    const out = captureVideoFrame('blob:https://example.com/gone');

    expect(out).toEqual({ ok: false, reason: 'no-match' });
  });

  it('reports no-dimensions before attempting any capture', () => {
    addVideo({ currentSrc: 'blob:https://example.com/aaa', videoWidth: 0 });

    const out = captureVideoFrame('blob:https://example.com/aaa');

    expect(out).toEqual({ ok: false, reason: 'no-dimensions' });
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('reports drm from attached media keys without reading pixels', () => {
    addVideo({ currentSrc: 'blob:https://example.com/aaa', mediaKeys: {} });

    const out = captureVideoFrame('blob:https://example.com/aaa');

    expect(out).toEqual({ ok: false, reason: 'drm' });
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('maps a readback SecurityError to tainted', () => {
    addVideo({ currentSrc: 'https://cdn.example.com/trip.mp4' });
    toDataURL.mockImplementation(() => {
      throw new DOMException('tainted', 'SecurityError');
    });

    const out = captureVideoFrame('https://cdn.example.com/trip.mp4');

    expect(out).toEqual({ ok: false, reason: 'tainted' });
  });

  it('walks the quality ladder down until the frame fits', () => {
    addVideo({ currentSrc: 'blob:https://example.com/aaa' });

    const big = `data:image/jpeg,${'x'.repeat(600000)}`;
    toDataURL
      .mockImplementationOnce(() => big)
      .mockImplementationOnce(() => big)
      .mockImplementationOnce(() => 'data:image/jpeg,fits');

    const out = captureVideoFrame('blob:https://example.com/aaa');

    expect(out).toMatchObject({ ok: true, dataUrl: 'data:image/jpeg,fits' });
    expect(toDataURL).toHaveBeenCalledTimes(3);
    expect(toDataURL.mock.calls.map((call) => call[1])).toEqual([0.85, 0.7, 0.55]);
  });

  it('reports too-large when every rung exceeds the handoff budget', () => {
    addVideo({ currentSrc: 'blob:https://example.com/aaa' });
    toDataURL.mockImplementation(() => `data:image/jpeg,${'x'.repeat(600000)}`);

    const out = captureVideoFrame('blob:https://example.com/aaa');

    expect(out).toEqual({ ok: false, reason: 'too-large' });
    expect(toDataURL).toHaveBeenCalledTimes(5);
  });
});
