import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropToSamBox, dataUrlToBytes, parseSamBoxes, selectSamBox } from './sam';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseSamBoxes', () => {
  it('parses box tokens with optional confidence', () => {
    const text =
      'Two finds: <|box;x1=100;y1=50;x2=500;y2=400;w=1000;h=800|> and ' +
      '<|box;x1=10;y1=20;x2=30;y2=40;w=100;h=100;c=0.9|> done.';
    expect(parseSamBoxes(text)).toEqual([
      { x1: 100, y1: 50, x2: 500, y2: 400, w: 1000, h: 800 },
      { x1: 10, y1: 20, x2: 30, y2: 40, w: 100, h: 100, c: 0.9 },
    ]);
  });

  it('drops malformed numbers and keeps the empty-output path empty', () => {
    expect(parseSamBoxes('no boxes here')).toEqual([]);
    expect(parseSamBoxes('')).toEqual([]);

    const text =
      '<|box;x1=NaN;y1=0;x2=10;y2=10;w=100;h=100|> ' +
      '<|box;x1=0;y1=Infinity;x2=10;y2=10;w=100;h=100|> ' +
      '<|box;x1=0;y1=0;x2=10;y2=10;w=0;h=100|> ' +
      '<|box;x1=0;y1=0;x2=10;y2=10;w=100;h=100;c=much|>';

    const parsed = parseSamBoxes(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ x1: 0, y1: 0, x2: 10, y2: 10, w: 100, h: 100 });
  });
});

describe('selectSamBox', () => {
  it('scales, pads, and picks the largest box', () => {
    const boxes = parseSamBoxes(
      '<|box;x1=100;y1=50;x2=500;y2=400;w=1000;h=800|> ' +
        '<|box;x1=0;y1=0;x2=100;y2=100;w=1000;h=800|>'
    );

    const best = selectSamBox(boxes, 500, 400);
    expect(best).not.toBeNull();
    // Token frame 1000x800 into 500x400: (50,25)-(250,200), padded 8%.
    expect(best?.x1).toBeCloseTo(50 - 200 * 0.08, 5);
    expect(best?.y1).toBeCloseTo(25 - 175 * 0.08, 5);
    expect(best?.x2).toBeCloseTo(250 + 200 * 0.08, 5);
    expect(best?.y2).toBeCloseTo(200 + 175 * 0.08, 5);
  });

  it('breaks area ties by confidence', () => {
    const boxes = parseSamBoxes(
      '<|box;x1=0;y1=0;x2=100;y2=100;w=200;h=200;c=0.2|> ' +
        '<|box;x1=100;y1=100;x2=200;y2=200;w=200;h=200;c=0.9|>'
    );

    const best = selectSamBox(boxes, 200, 200);
    // Second box padded: (100-8, 100-8).
    expect(best?.x1).toBeCloseTo(92, 5);
  });

  it('rejects inverted, tiny, and degenerate boxes', () => {
    const inverted = parseSamBoxes('<|box;x1=500;y1=400;x2=100;y2=50;w=1000;h=800|>');
    expect(selectSamBox(inverted, 500, 400)).toBeNull();

    const tiny = parseSamBoxes('<|box;x1=0;y1=0;x2=2;y2=2;w=1000;h=1000|>');
    expect(selectSamBox(tiny, 1000, 1000)).toBeNull();

    const outside = parseSamBoxes('<|box;x1=2000;y1=2000;x2=3000;y2=3000;w=1000;h=1000|>');
    expect(selectSamBox(outside, 500, 500)).toBeNull();
  });

  it('clamps overflowing boxes to the frame', () => {
    const boxes = parseSamBoxes('<|box;x1=800;y1=600;x2=1200;y2=1200;w=1000;h=1000|>');

    const best = selectSamBox(boxes, 500, 500);
    expect(best?.x2).toBe(500);
    expect(best?.y2).toBe(500);
    expect(best?.x1).toBeGreaterThanOrEqual(0);
  });
});

describe('dataUrlToBytes', () => {
  it('decodes base64 image URLs and rejects the rest', () => {
    const bytes = dataUrlToBytes('data:image/jpeg;base64,/wA=');
    expect(bytes).toEqual(new Uint8Array([255, 0]));
    expect(dataUrlToBytes('https://example.com/a.jpg')).toBeNull();
    expect(dataUrlToBytes('data:image/svg+xml,<svg/>')).toBeNull();
    expect(dataUrlToBytes('data:image/jpeg;base64,!!!')).toBeNull();
  });
});

describe('cropToSamBox', () => {
  it('crops the validated region into a bounded JPEG', async () => {
    const drawImage = vi.fn();
    vi.stubGlobal(
      'OffscreenCanvas',
      vi.fn().mockImplementation(function (this: unknown, width: number, height: number) {
        return {
          width,
          height,
          getContext: () => ({ drawImage }),
          convertToBlob: async () => new Blob(['crop']),
        };
      })
    );

    const bitmap = { width: 2000, height: 1000 } as ImageBitmap;

    const url = await cropToSamBox(bitmap, { x1: 100, y1: 50, x2: 1700, y2: 850 });
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    // 1600x800 crop scaled to the 1280 cap.
    expect(drawImage).toHaveBeenCalledWith(bitmap, 100, 50, 1600, 800, 0, 0, 1280, 640);
  });
});
