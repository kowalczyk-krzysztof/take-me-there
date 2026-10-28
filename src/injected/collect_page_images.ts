export interface HarvestedImage {
  url: string;
  caption: string;
  heading: string;
  width: number;
  height: number;
}

export const collectPageImages = (): HarvestedImage[] => {
  const MAX_IMAGES = 12;
  const MIN_LONG_SIDE = 200;
  const MAX_FIELD = 300;
  const MAX_DATA_URL = 100000;
  const MAX_TOTAL = 262144;
  const SCAN_CAP = 2000;
  const HOP_CAP = 6;

  const abs = (u: string): string => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const clean = (s: string | null | undefined): string =>
    (s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
  // Nearest preceding heading, walking up from the image (hop-capped).
  const nearestHeading = (img: HTMLImageElement): string => {
    let hops = 0;
    for (
      let el: HTMLElement | null = img;
      el && el !== document.documentElement && hops < HOP_CAP;
      el = el.parentElement
    ) {
      hops += 1;
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName)) {
          return clean(sib.textContent);
        }
        const inner = sib.querySelector('h1, h2, h3, h4, h5, h6');
        if (inner) {
          return clean(inner.textContent);
        }
      }
    }
    return '';
  };

  const captionFor = (img: HTMLImageElement): string => {
    const alt = clean(img.getAttribute('alt'));
    if (alt) {
      return alt;
    }
    const figure = img.closest('figure');
    const figcaption = figure?.querySelector('figcaption');
    return clean(figcaption?.textContent);
  };

  const strip = (u: string): string => {
    const cut = u.search(/[?#]/);
    return cut < 0 ? u : u.slice(0, cut);
  };

  const candidates: HarvestedImage[] = [];
  const seen = new Set<string>();
  const imgs = [...document.querySelectorAll('img')].slice(0, SCAN_CAP);

  for (const img of imgs) {
    const url = abs(img.currentSrc || img.getAttribute('src') || '');

    if (!url) {
      continue;
    }

    const schemeOk =
      url.startsWith('https://') ||
      url.startsWith('http://') ||
      (url.startsWith('data:image/') && url.length <= MAX_DATA_URL);

    if (!schemeOk) {
      continue;
    }
    // Rendered-large gate: layout size, not file bytes (unavailable here).
    // No aspect gate: panoramas are legitimate travel photos.
    const rect = img.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);

    if (Math.max(width, height) < MIN_LONG_SIDE) {
      continue;
    }

    const dedupe = strip(url);

    if (seen.has(dedupe)) {
      continue;
    }

    seen.add(dedupe);
    candidates.push({
      url,
      caption: captionFor(img),
      heading: nearestHeading(img),
      width,
      height,
    });
  }

  // Largest rendered area first, then the total-size guard caps the handoff.
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  const out: HarvestedImage[] = [];
  let total = 0;

  for (const candidate of candidates) {
    if (out.length >= MAX_IMAGES) {
      break;
    }

    total += candidate.url.length + candidate.caption.length + candidate.heading.length;

    if (total > MAX_TOTAL) {
      break;
    }

    out.push(candidate);
  }

  return out;
};
