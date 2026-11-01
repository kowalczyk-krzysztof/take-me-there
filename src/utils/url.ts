// Loopback over plain http is fetchable from the extension without a host
// grant and without leaking anything past the machine.
export const isLoopbackHttp = (srcUrl: string): boolean => {
  try {
    const parsed = new URL(srcUrl);

    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]')
    );
  } catch {
    return false;
  }
};
