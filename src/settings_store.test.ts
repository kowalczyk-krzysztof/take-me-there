import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings, parseEndpointOrigin } from './settings_store';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('parseEndpointOrigin', () => {
  it('accepts HTTPS anywhere', () => {
    expect(parseEndpointOrigin('https://llm.example.com/v1')).toBe('https://llm.example.com');
    expect(parseEndpointOrigin('https://127.0.0.1:8080/deep/path')).toBe('https://127.0.0.1:8080');
  });

  it('accepts HTTP only for loopback hosts', () => {
    expect(parseEndpointOrigin('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(parseEndpointOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(() => parseEndpointOrigin('http://192.168.1.2:11434/v1')).toThrow();
    expect(() => parseEndpointOrigin('http://remote.example.com/v1')).toThrow();
    expect(() => parseEndpointOrigin('http://[::1]:11434/v1')).toThrow();
  });

  it('rejects non-HTTP schemes and garbage', () => {
    expect(() => parseEndpointOrigin('not a url')).toThrow();
    expect(() => parseEndpointOrigin('')).toThrow();
    expect(() => parseEndpointOrigin('file:///tmp/x')).toThrow();
    expect(() => parseEndpointOrigin('ftp://example.com/x')).toThrow();
    expect(() => parseEndpointOrigin('https://')).toThrow();
  });
});

describe('cacheTtlDays', () => {
  it('defaults to a week', async () => {
    expect((await loadSettings()).cacheTtlDays).toBe(7);
  });

  it('keeps valid choices and repairs anything else', async () => {
    for (const days of [1, 7, 30]) {
      await mock.local.set({ settings: { v: 1, settings: { cacheTtlDays: days } } });
      expect((await loadSettings()).cacheTtlDays).toBe(days);
    }

    for (const days of [0, 2, -7, '7', null, Number.NaN]) {
      await mock.local.set({ settings: { v: 1, settings: { cacheTtlDays: days } } });
      expect((await loadSettings()).cacheTtlDays).toBe(7);
    }
  });
});
