export type FrameFailureReason = 'no-match' | 'no-dimensions' | 'tainted' | 'drm' | 'too-large';

export interface CapturedFrame {
  ok: true;
  dataUrl: string;
  time: number;
  width: number;
  height: number;
}

export interface FrameMiss {
  ok: false;
  reason: FrameFailureReason;
}

export type CaptureVideoFrameResult = CapturedFrame | FrameMiss;

export const captureVideoFrame = (srcUrl: string): CaptureVideoFrameResult => {
  const MAX_BYTES = 512000;

  const abs = (u: string): string => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const target = abs(srcUrl);

  const videos = [...document.querySelectorAll('video')].slice(0, 500);

  // Exact identity only: query parameters name the clip, so a pathname-only
  // fallback can capture a different video. No match means no pixels.
  const video = videos.find((v) => abs(v.currentSrc) === target || abs(v.src) === target) ?? null;

  if (!video) {
    return { ok: false, reason: 'no-match' };
  }

  if (video.mediaKeys != null) {
    return { ok: false, reason: 'drm' };
  }

  if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) {
    return { ok: false, reason: 'no-dimensions' };
  }

  const canvas = document.createElement('canvas');

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return { ok: false, reason: 'no-dimensions' };
  }
  const attempts: Array<[number, number]> = [
    [1280, 0.85],
    [1280, 0.7],
    [1280, 0.55],
    [960, 0.7],
    [960, 0.55],
  ];

  for (const [maxSide, quality] of attempts) {
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return { ok: false, reason: 'no-dimensions' };
    }

    let dataUrl = '';

    try {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    } catch {
      // Cross-origin pixels without CORS taint the canvas.
      return { ok: false, reason: 'tainted' };
    }

    if (dataUrl.length <= MAX_BYTES) {
      return {
        ok: true,
        dataUrl,
        time: video.currentTime || 0,
        width: canvas.width,
        height: canvas.height,
      };
    }
  }

  return { ok: false, reason: 'too-large' };
};
