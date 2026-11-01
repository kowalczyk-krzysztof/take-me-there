import { describe, expect, it } from 'vitest';
import { isLoopbackHttp } from './url';

describe('isLoopbackHttp', () => {
  it('matches http loopback hosts only', () => {
    expect(isLoopbackHttp('http://localhost:8000/oia.jpg')).toBe(true);
    expect(isLoopbackHttp('http://127.0.0.1/oia.jpg')).toBe(true);
    expect(isLoopbackHttp('http://[::1]/oia.jpg')).toBe(true);
    expect(isLoopbackHttp('https://localhost/oia.jpg')).toBe(false);
    expect(isLoopbackHttp('http://example.com/oia.jpg')).toBe(false);
    expect(isLoopbackHttp('https://cdn.example.com/oia.jpg')).toBe(false);
    expect(isLoopbackHttp('not a url')).toBe(false);
  });
});
