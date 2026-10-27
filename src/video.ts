// Video-rung selection: which mp4 URLs may ride rung 2, the frame cache
// seed, and the one-time first-video confirm flag (mirrors the consent
// flag: local storage, ever-persistent, fail-closed).
const VIDEO_CONFIRM_KEY = 'videoFrameConsent';
const MAX_DATA_VIDEO_LENGTH = 50000000;

export const hasVideoConsented = async (): Promise<boolean> => {
  try {
    const stored = (await chrome.storage.local.get(VIDEO_CONFIRM_KEY)) as {
      videoFrameConsent?: unknown;
    };
    return stored.videoFrameConsent === true;
  } catch {
    return false;
  }
};

export const setVideoConsented = async (): Promise<void> => {
  await chrome.storage.local.set({ [VIDEO_CONFIRM_KEY]: true });
};

// Rung 2 carries full motion plus the soundtrack, so the URL bar is high:
// public https only (server-fetched), manifests and blobs rejected, inline
// data: video capped at 50 MB.
export const isMp4RungUsable = (srcUrl: string): boolean => {
  if (!srcUrl || srcUrl.startsWith('blob:')) {
    return false;
  }
  if (srcUrl.startsWith('data:video/mp4')) {
    return srcUrl.length < MAX_DATA_VIDEO_LENGTH;
  }
  let parsed: URL;
  try {
    parsed = new URL(srcUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  return !path.endsWith('.m3u8') && !path.endsWith('.mpd');
};

// Frame cache key seed: the blob: address is unstable across loads, so the
// key is the page plus the whole-second timestamp of the captured frame.
export const frameCacheSeed = (time: number): string => `#t=${Math.floor(time)}`;
