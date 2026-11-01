// Bounded stream drain for untrusted response bodies: reads through a byte
// cap instead of materializing unboundedly. Injected page modules cannot
// import this file, so fetch_image_bytes keeps its own loop by necessity.
export class CapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapExceededError';
  }
}

export const readCappedBytes = async (
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> => {
  const reader = body.getReader();

  const chunks: Uint8Array[] = [];

  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }
    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);

      throw new CapExceededError(`body exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }

  reader.releaseLock();

  const bytes = new Uint8Array(total);

  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};
