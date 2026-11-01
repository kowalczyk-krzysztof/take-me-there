import { afterEach, describe, expect, it } from 'vitest';
import { installChromeMock, uninstallChromeMock } from './test/chrome_mock';
import {
  frameCacheSeed,
  hasFullVideoConsented,
  hasVideoConsented,
  isRung2Usable,
  setFullVideoConsented,
  setVideoConsented,
} from './video';

afterEach(() => {
  uninstallChromeMock();
});

describe('isRung2Usable', () => {
  it('accepts a public https mp4', () => {
    expect(isRung2Usable('https://cdn.example.com/trip.mp4')).toBe(true);
  });

  it('accepts https mp4 with a query string', () => {
    expect(isRung2Usable('https://cdn.example.com/trip.mp4?token=abc')).toBe(true);
  });

  it('rejects empty, blob, and unparseable URLs', () => {
    expect(isRung2Usable('')).toBe(false);
    expect(isRung2Usable('blob:https://example.com/aaa')).toBe(false);
    expect(isRung2Usable('not a url')).toBe(false);
  });

  it('rejects manifests by extension, case-insensitively', () => {
    expect(isRung2Usable('https://cdn.example.com/live.m3u8')).toBe(false);
    expect(isRung2Usable('https://cdn.example.com/live.MPD')).toBe(false);
  });

  it('keeps mp4s whose names merely contain manifest letters', () => {
    expect(isRung2Usable('https://cdn.example.com/compday.mp4')).toBe(true);
  });

  it('rejects plain http', () => {
    expect(isRung2Usable('http://cdn.example.com/trip.mp4')).toBe(false);
  });

  it('caps inline data video at 50 MB', () => {
    expect(isRung2Usable('data:video/mp4;base64,AAAA')).toBe(true);
    expect(isRung2Usable(`data:video/mp4;base64,${'A'.repeat(50000000)}`)).toBe(false);
  });

  it('rejects non-mp4 data video', () => {
    expect(isRung2Usable('data:video/webm;base64,AAAA')).toBe(false);
  });
});

describe('frameCacheSeed', () => {
  it('seeds on the whole-second timestamp', () => {
    expect(frameCacheSeed(12.9, 'https://cdn.example.com/a.mp4')).toBe(
      'https://cdn.example.com/a.mp4#t=12'
    );
    expect(frameCacheSeed(0, 'https://cdn.example.com/a.mp4')).toBe(
      'https://cdn.example.com/a.mp4#t=0'
    );
    expect(frameCacheSeed(12.9, 'https://cdn.example.com/b.mp4')).not.toBe(
      frameCacheSeed(12.9, 'https://cdn.example.com/a.mp4')
    );
    expect(frameCacheSeed(5, 'https://cdn.example.com/a.mp4?sig=abc#frag')).toBe(
      'https://cdn.example.com/a.mp4?sig=abc#t=5'
    );
    expect(frameCacheSeed(5, 'https://cdn.example.com/a.mp4?id=A')).not.toBe(
      frameCacheSeed(5, 'https://cdn.example.com/a.mp4?id=B')
    );
  });
});

describe('video confirm flag', () => {
  it('is unset by default and persists once set', async () => {
    installChromeMock();
    expect(await hasVideoConsented()).toBe(false);
    await setVideoConsented();
    expect(await hasVideoConsented()).toBe(true);
  });
});

describe('full-media consent', () => {
  it('is independent of frame consent', async () => {
    installChromeMock();
    expect(await hasFullVideoConsented()).toBe(false);
    await setVideoConsented();
    expect(await hasFullVideoConsented()).toBe(false);
    await setFullVideoConsented();
    expect(await hasFullVideoConsented()).toBe(true);
    expect(await hasVideoConsented()).toBe(true);
  });
});
