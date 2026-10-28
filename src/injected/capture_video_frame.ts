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
  // storage.session carries the handoff: keep the frame well under quota.
  const MAX_BYTES = 512000;
  const abs = (u: string): string => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return '';
    }
  };
  const strip = (u: string): string => {
    const href = abs(u);
    const cut = href.search(/[?#]/);
    return cut < 0 ? href : href.slice(0, cut);
  };

  const target = abs(srcUrl);
  const bare = strip(srcUrl);
  const videos = [...document.querySelectorAll('video')].slice(0, 500);
  const byExact = videos.find((v) => abs(v.currentSrc) === target || abs(v.src) === target) ?? null;
  const byBare =
    byExact ??
    videos.find((v) => {
      if (!bare) {
        return false;
      }
      return strip(v.currentSrc) === bare || strip(v.src) === bare;
    }) ??
    null;
  // Last resort: the frame's playing video, but only when exactly one
  // candidate exists. On multi-video pages a wrong guess could capture a
  // webcam or meeting frame the user never clicked.
  const playing = videos.filter((v) => !v.paused && !v.ended && v.readyState >= 2);
  const video = byBare ?? (playing.length === 1 ? playing[0] : null);

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
  // Descending quality ladder: start at full rung-1 fidelity (1280px, q0.85)
  // and shrink until the frame fits the session handoff.
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
      // Readback failed: cross-origin pixels without CORS approval taint
      // the canvas, so the frame can never leave the page this way.
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
