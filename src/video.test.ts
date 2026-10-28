import { afterEach, describe, expect, it } from 'vitest';
import { installChromeMock, uninstallChromeMock } from './test/chrome_mock';
import { frameCacheSeed, hasVideoConsented, isMp4RungUsable, setVideoConsented } from './video';

afterEach(() => {
  uninstallChromeMock();
});

describe('isMp4RungUsable', () => {
  it('accepts a public https mp4', () => {
    expect(isMp4RungUsable('https://cdn.example.com/trip.mp4')).toBe(true);
  });

  it('accepts https mp4 with a query string', () => {
    expect(isMp4RungUsable('https://cdn.example.com/trip.mp4?token=abc')).toBe(true);
  });

  it('rejects empty, blob, and unparseable URLs', () => {
    expect(isMp4RungUsable('')).toBe(false);
    expect(isMp4RungUsable('blob:https://example.com/aaa')).toBe(false);
    expect(isMp4RungUsable('not a url')).toBe(false);
  });

  it('rejects manifests by extension, case-insensitively', () => {
    expect(isMp4RungUsable('https://cdn.example.com/live.m3u8')).toBe(false);
    expect(isMp4RungUsable('https://cdn.example.com/live.MPD')).toBe(false);
  });

  it('keeps mp4s whose names merely contain manifest letters', () => {
    expect(isMp4RungUsable('https://cdn.example.com/compday.mp4')).toBe(true);
  });

  it('rejects plain http', () => {
    expect(isMp4RungUsable('http://cdn.example.com/trip.mp4')).toBe(false);
  });

  it('caps inline data video at 50 MB', () => {
    expect(isMp4RungUsable('data:video/mp4;base64,AAAA')).toBe(true);
    expect(isMp4RungUsable(`data:video/mp4;base64,${'A'.repeat(50000000)}`)).toBe(false);
  });

  it('rejects non-mp4 data video', () => {
    expect(isMp4RungUsable('data:video/webm;base64,AAAA')).toBe(false);
  });
});

describe('frameCacheSeed', () => {
  it('seeds on the whole-second timestamp', () => {
    expect(frameCacheSeed(12.9)).toBe('#t=12');
    expect(frameCacheSeed(0)).toBe('#t=0');
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
