const VIDEO_CONFIRM_KEY = 'videoFrameConsent';
// Frame-only consent: the captured still plus page text.
const VIDEO_CONSENT_VERSION: number = 1;

// Full-media consent: the video URL leaves the device for remote
// processing of the whole clip and its soundtrack. A separate flag so
// legacy frame consent never establishes full-media approval.
const VIDEO_FULL_KEY = 'videoFullConsent';
const VIDEO_FULL_VERSION: number = 1;

const MAX_DATA_VIDEO_LENGTH = 50000000;

const readVersionedFlag = async (key: string, version: number): Promise<boolean> => {
  try {
    const stored = (await chrome.storage.local.get(key)) as Record<string, unknown>;

    const value = stored[key];

    if (value === true) {
      return version === 1;
    }

    if (typeof value === 'object' && value !== null) {
      return (value as { v?: unknown }).v === version;
    }

    return false;
  } catch {
    return false;
  }
};

export const hasVideoConsented = async (): Promise<boolean> =>
  readVersionedFlag(VIDEO_CONFIRM_KEY, VIDEO_CONSENT_VERSION);

export const setVideoConsented = async (): Promise<void> => {
  await chrome.storage.local.set({
    [VIDEO_CONFIRM_KEY]: { v: VIDEO_CONSENT_VERSION, at: new Date().toISOString() },
  });
};

export const hasFullVideoConsented = async (): Promise<boolean> =>
  readVersionedFlag(VIDEO_FULL_KEY, VIDEO_FULL_VERSION);

export const setFullVideoConsented = async (): Promise<void> => {
  await chrome.storage.local.set({
    [VIDEO_FULL_KEY]: { v: VIDEO_FULL_VERSION, at: new Date().toISOString() },
  });
};

// Rung 2 carries full motion plus the soundtrack, so the URL bar is high: public https only.
export const isRung2Usable = (srcUrl: string): boolean => {
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

// The blob: address is unstable, so the key is the page plus the whole-second timestamp; query parameters survive.
export const frameCacheSeed = (time: number, srcUrl: string): string => {
  let stripped = srcUrl;

  try {
    const parsed = new URL(srcUrl);
    parsed.hash = '';
    stripped = parsed.toString();
  } catch {}

  return `${stripped}#t=${Math.floor(time)}`;
};
