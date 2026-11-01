// Chunked base64 transcoding without call-stack blowups on multi-megabyte
// inputs. Injected page modules cannot import this file, so
// fetch_image_bytes keeps its own copy by necessity.
export const encodeBase64 = (bytes: Uint8Array): string => {
  const toBase64 = (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64;

  if (typeof toBase64 === 'function') {
    return (toBase64 as (this: Uint8Array) => string).call(bytes);
  }

  let binary = '';

  const CHUNK = 0x8000;

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return btoa(binary);
};

export const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
};
