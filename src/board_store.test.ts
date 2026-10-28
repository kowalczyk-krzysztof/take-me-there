import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_CAP,
  BOARD_STORAGE_KEY,
  THUMB_MAX_BYTES,
  clearBoard,
  dedupeKeyFor,
  listPins,
  makeThumbnail,
  pinPlace,
  removePin,
  stripUrlEphemera,
  type BoardPin,
} from './board_store';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './test/chrome_mock';

const PLACE = (overrides: Record<string, unknown> = {}) => ({
  identified: true,
  placeName: 'Oia',
  city: 'Oia',
  country: 'Greece',
  confidence: 0.9,
  oneLiner: 'Blue domes over the caldera.',
  ...overrides,
});

const PIN = (overrides: Partial<BoardPin> = {}): Omit<BoardPin, 'addedAt'> => ({
  place: PLACE(),
  sourceHost: 'example.com',
  ...overrides,
});

let mock: ChromeMock;

let imageDims = { w: 1024, h: 768, fail: false };
const drawImage = vi.fn();
const toDataURL = vi.fn((_type: string, _quality: number): string => 'data:image/jpeg,small');

beforeEach(() => {
  mock = installChromeMock();
  imageDims = { w: 1024, h: 768, fail: false };
  drawImage.mockClear();
  toDataURL.mockClear();
  toDataURL.mockImplementation(() => 'data:image/jpeg,small');
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      #src = '';
      get src(): string {
        return this.#src;
      }
      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => {
          if (imageDims.fail) {
            this.onerror?.();
          } else {
            this.naturalWidth = imageDims.w;
            this.naturalHeight = imageDims.h;
            this.onload?.();
          }
        });
      }
    }
  );
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D
  ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL =
    toDataURL as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
});

afterEach(() => {
  uninstallChromeMock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('board_store', () => {
  it('pins and lists in insertion order', async () => {
    await pinPlace({ ...PIN(), addedAt: 2 });
    await pinPlace({ ...PIN({ place: PLACE({ placeName: 'Fira' }) }), addedAt: 1 });
    const pins = await listPins();
    expect(pins.map((pin) => pin.place.placeName)).toEqual(['Fira', 'Oia']);
  });

  it('strips query and fragment from stored image URLs', async () => {
    expect(stripUrlEphemera('https://cdn.example.com/a.jpg?sig=abc#frag')).toBe(
      'https://cdn.example.com/a.jpg'
    );
    expect(stripUrlEphemera('data:image/jpeg,AAA')).toBe('data:image/jpeg,AAA');
    await pinPlace({ ...PIN({ imageUrl: 'https://cdn.example.com/a.jpg?sig=abc#frag' }) });
    const pins = await listPins();
    expect(pins).toHaveLength(1);
    expect(pins[0].imageUrl).toBe('https://cdn.example.com/a.jpg');
  });

  it('keeps the existing pin on a dedupe hit', async () => {
    await pinPlace(PIN({ sourceHost: 'first.example' }));
    const out = await pinPlace(PIN({ sourceHost: 'second.example' }));
    expect(out.status).toBe('duplicate');
    expect((await listPins())[0].sourceHost).toBe('first.example');
  });

  it('treats names differing only by case or control chars as duplicates', async () => {
    await pinPlace(PIN());
    const out = await pinPlace(PIN({ place: PLACE({ placeName: 'OIA\n' }) }));
    expect(out.status).toBe('duplicate');
  });

  it('never collides tuples across the separator', async () => {
    const a = await dedupeKeyFor('A|B', 'C');
    const b = await dedupeKeyFor('A', 'B|C');
    const c = await dedupeKeyFor('A|B', 'C');
    expect(a).not.toBe(b);
    expect(a).toBe(c);
    await pinPlace(PIN({ place: PLACE({ placeName: 'A|B', country: 'C' }) }));
    const out = await pinPlace(PIN({ place: PLACE({ placeName: 'A', country: 'B|C' }) }));
    expect(out.status).toBe('pinned');
  });

  it('evicts the oldest pin at the cap', async () => {
    for (let i = 0; i < BOARD_CAP; i++) {
      await pinPlace({
        ...PIN({ place: PLACE({ placeName: `Place ${i}` }) }),
        addedAt: i,
      });
    }
    const out = await pinPlace({
      ...PIN({ place: PLACE({ placeName: 'Newest' }) }),
      addedAt: BOARD_CAP,
    });
    expect(out.status).toBe('pinned');
    if (out.status !== 'pinned') {
      throw new Error('unreachable');
    }
    expect(out.evicted?.place.placeName).toBe('Place 0');
    const pins = await listPins();
    expect(pins).toHaveLength(BOARD_CAP);
    expect(pins.map((pin) => pin.place.placeName)).not.toContain('Place 0');
  });

  it('removes by tuple and clears everything', async () => {
    await pinPlace(PIN());
    await pinPlace(PIN({ place: PLACE({ placeName: 'Fira' }) }));
    const remaining = await removePin('Oia', 'Greece');
    expect(remaining.map((pin) => pin.place.placeName)).toEqual(['Fira']);
    expect(await removePin('Nowhere', 'Atlantis')).toHaveLength(1);
    await clearBoard();
    expect(await listPins()).toEqual([]);
  });

  it('throws on storage rejection so the panel can offer the retry', async () => {
    vi.spyOn(mock.local, 'set').mockRejectedValueOnce(new Error('quota'));
    await expect(pinPlace(PIN())).rejects.toThrow('quota');
    expect(await listPins()).toEqual([]);
  });

  it('migrates a legacy bare-array board to the versioned record', async () => {
    await mock.local.set({ [BOARD_STORAGE_KEY]: [{ ...PIN(), addedAt: 1 }] });
    expect(await listPins()).toHaveLength(1);
    const out = await pinPlace(PIN({ place: PLACE({ placeName: 'Fira' }) }));
    expect(out.status).toBe('pinned');
    const record = mock.local.data.get(BOARD_STORAGE_KEY) as { v: number; pins: unknown[] };
    expect(record.v).toBe(1);
    expect(record.pins).toHaveLength(2);
  });

  it('aborts the pin when the board cannot be read', async () => {
    await pinPlace(PIN());
    const before = mock.local.data.get(BOARD_STORAGE_KEY);
    vi.spyOn(mock.local, 'get').mockRejectedValueOnce(new Error('io'));
    await expect(pinPlace(PIN({ place: PLACE({ placeName: 'Fira' }) }))).rejects.toThrow('io');
    expect(mock.local.data.get(BOARD_STORAGE_KEY)).toBe(before);
    expect(await listPins()).toHaveLength(1);
  });

  it('refuses to overwrite a record it does not understand', async () => {
    await mock.local.set({ [BOARD_STORAGE_KEY]: { v: 99, pins: [] } });
    await expect(pinPlace(PIN())).rejects.toThrow('unwritable');
    expect(mock.local.data.get(BOARD_STORAGE_KEY)).toEqual({ v: 99, pins: [] });
  });

  it('drops corrupt entries instead of crashing', async () => {
    await mock.local.set({
      [BOARD_STORAGE_KEY]: [
        { nope: true },
        { ...PIN(), addedAt: 1 },
        'junk',
        { place: { placeName: 42 } },
      ],
    });
    const pins = await listPins();
    expect(pins).toHaveLength(1);
    expect(pins[0].place.placeName).toBe('Oia');
  });
});

describe('makeThumbnail', () => {
  it('builds a capped JPEG from held bytes', async () => {
    const out = await makeThumbnail('data:image/jpeg,aaa');
    expect(out).toBe('data:image/jpeg,small');
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('rejects remote URLs and oversized sources by construction', async () => {
    expect(await makeThumbnail('https://cdn.example.com/oia.jpg')).toBeNull();
    expect(await makeThumbnail(`data:image/jpeg,${'x'.repeat(4000001)}`)).toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('returns null on decode failure, empty frames, and taint', async () => {
    imageDims = { w: 1024, h: 768, fail: true };
    expect(await makeThumbnail('data:image/jpeg,aaa')).toBeNull();
    imageDims = { w: 0, h: 0, fail: false };
    expect(await makeThumbnail('data:image/jpeg,aaa')).toBeNull();
    imageDims = { w: 1024, h: 768, fail: false };
    toDataURL.mockImplementation(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    expect(await makeThumbnail('data:image/jpeg,aaa')).toBeNull();
  });

  it('walks the quality ladder and fails closed above the cap', async () => {
    const big = `data:image/jpeg,${'x'.repeat(THUMB_MAX_BYTES)}`;
    toDataURL
      .mockImplementationOnce(() => big)
      .mockImplementationOnce(() => 'data:image/jpeg,fits');
    expect(await makeThumbnail('data:image/jpeg,aaa')).toBe('data:image/jpeg,fits');
    expect(toDataURL.mock.calls.map((call) => call[1])).toEqual([0.85, 0.7]);
    toDataURL.mockImplementation(() => big);
    expect(await makeThumbnail('data:image/jpeg,aaa')).toBeNull();
    expect(toDataURL).toHaveBeenCalledTimes(2 + 4);
  });
});
