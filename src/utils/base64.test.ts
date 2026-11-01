import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64';

describe('encodeBase64', () => {
  it('round-trips bytes through the chunked path', () => {
    const proto = Uint8Array.prototype as unknown as { toBase64?: unknown };

    const native = proto.toBase64;
    delete proto.toBase64;

    try {
      const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 251);

      const decoded = Uint8Array.from(atob(encodeBase64(bytes)), (ch) => ch.charCodeAt(0));
      expect(decoded).toEqual(bytes);
    } finally {
      if (native !== undefined) {
        proto.toBase64 = native;
      }
    }
  });
});

describe('decodeBase64', () => {
  it('decodes bytes and rejects malformed input', () => {
    expect([...decodeBase64('aGk=')]).toEqual([104, 105]);
    expect(() => decodeBase64('!!!')).toThrow();
  });
});
