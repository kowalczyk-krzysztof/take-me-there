import { encodeBase64, FETCH_JPEG_QUALITY, FETCH_MAX_SIDE } from './image_fetch';

export interface SamTokenBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  c?: number;
}

export interface SamPixelBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const BOX_TOKEN_RE =
  /<\|box;x1=([^;]+);y1=([^;]+);x2=([^;]+);y2=([^;]+);w=([^;]+);h=([^;|]+)(?:;c=([^;|]+))?\|>/g;

const SAM_BOX_PADDING = 0.08;

const SAM_MIN_AREA_FRAC = 0.01;

const finite = (value: string): number | null => {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
};

// Parse every box token in the answer, dropping malformed numbers. NaN,
// infinities, and absurd magnitudes never survive this pass.
export const parseSamBoxes = (text: string): SamTokenBox[] => {
  const boxes: SamTokenBox[] = [];
  BOX_TOKEN_RE.lastIndex = 0;

  for (;;) {
    const match = BOX_TOKEN_RE.exec(text);

    if (!match) {
      break;
    }

    const [, x1, y1, x2, y2, w, h, c] = match as unknown as string[];

    const coords = [x1, y1, x2, y2, w, h].map((part) => finite(part ?? ''));

    if (coords.some((coord) => coord === null)) {
      continue;
    }

    const [bx1, by1, bx2, by2, bw, bh] = coords as number[];

    if (bw <= 0 || bh <= 0) {
      continue;
    }

    const box: SamTokenBox = { x1: bx1, y1: by1, x2: bx2, y2: by2, w: bw, h: bh };

    if (c !== undefined) {
      const confidence = finite(c);

      if (confidence !== null) {
        box.c = confidence;
      }
    }
    boxes.push(box);
  }

  return boxes;
};

// Pick the largest-area box (highest confidence breaks ties), scaled from
// the token's w/h reference frame into image pixels, padded ~8%, clamped to
// the frame, and rejected below the minimum area or on inverted edges.
export const selectSamBox = (
  boxes: SamTokenBox[],
  imageWidth: number,
  imageHeight: number
): SamPixelBox | null => {
  let best: SamPixelBox | null = null;

  let bestArea = 0;

  let bestConfidence = -Infinity;

  for (const box of boxes) {
    if (!(box.x2 > box.x1) || !(box.y2 > box.y1)) {
      continue;
    }

    const scaleX = imageWidth / box.w;

    const scaleY = imageHeight / box.h;

    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
      continue;
    }

    let x1 = box.x1 * scaleX;

    let y1 = box.y1 * scaleY;

    let x2 = box.x2 * scaleX;

    let y2 = box.y2 * scaleY;

    const padX = (x2 - x1) * SAM_BOX_PADDING;

    const padY = (y2 - y1) * SAM_BOX_PADDING;
    x1 = Math.max(0, x1 - padX);
    y1 = Math.max(0, y1 - padY);
    x2 = Math.min(imageWidth, x2 + padX);
    y2 = Math.min(imageHeight, y2 + padY);

    if (!(x2 > x1) || !(y2 > y1)) {
      continue;
    }

    const area = (x2 - x1) * (y2 - y1);

    if (area < imageWidth * imageHeight * SAM_MIN_AREA_FRAC) {
      continue;
    }

    const confidence = box.c ?? -Infinity;

    if (area > bestArea || (area === bestArea && confidence > bestConfidence)) {
      best = { x1, y1, x2, y2 };
      bestArea = area;
      bestConfidence = confidence;
    }
  }

  return best;
};

export const dataUrlToBytes = (dataUrl: string): Uint8Array | null => {
  const marker = ';base64,';

  const at = dataUrl.indexOf(marker);

  if (!dataUrl.startsWith('data:image/') || at < 0) {
    return null;
  }

  try {
    const binary = atob(dataUrl.slice(at + marker.length));

    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
};

// Crop the bitmap to the validated box, downscaling the crop to the fetch
// cap so the re-identify stays bounded. Returns a JPEG data: URL.
export const cropToSamBox = async (bitmap: ImageBitmap, box: SamPixelBox): Promise<string> => {
  const sw = Math.max(1, Math.round(box.x2 - box.x1));

  const sh = Math.max(1, Math.round(box.y2 - box.y1));

  const scale = Math.min(1, FETCH_MAX_SIDE / Math.max(sw, sh));

  const dw = Math.max(1, Math.round(sw * scale));

  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = new OffscreenCanvas(dw, dh);

  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('2d canvas context unavailable');
  }

  ctx.drawImage(bitmap, box.x1, box.y1, sw, sh, 0, 0, dw, dh);

  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: FETCH_JPEG_QUALITY });

  const out = new Uint8Array(await jpeg.arrayBuffer());

  if (out.length === 0) {
    throw new Error('JPEG encoding returned no bytes');
  }

  return `data:image/jpeg;base64,${encodeBase64(out)}`;
};
