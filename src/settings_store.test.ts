import { describe, expect, it } from 'vitest';
import { parseEndpointOrigin } from './settings_store';

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
