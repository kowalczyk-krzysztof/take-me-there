export interface JsonLdPlace {
  types: string[];
  name: string;
  locality: string;
  country: string;
  lat: number | null;
  lon: number | null;
}

export interface PageSignalData {
  imgFound: boolean;
  alt: string;
  imgTitle: string;
  figcaption: string;
  nearestHeading: string;
  nearestParagraph: string;
  ogTitle: string;
  ogDescription: string;
  ogSiteName: string;
  docTitle: string;
  metaDescription: string;
  canonical: string;
  pageHost: string;
  urlSlug: string;
  imgFileSlug: string;
  jsonLd: JsonLdPlace[];
}

export const collectSignals = (srcUrl: string): PageSignalData => {
  const abs = (u: string): string => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return '';
    }
  };

  const target = abs(srcUrl);
  // toWellFormed last: slicing and page-controlled text can both leave lone
  // surrogates that would throw in encodeURIComponent downstream.
  const clean = (s: string | null | undefined): string =>
    (s || '').replace(/\s+/g, ' ').trim().slice(0, 300).toWellFormed();
  const meta = (sel: string): string => clean(document.querySelector(sel)?.getAttribute('content'));

  // Locate the clicked img: currentSrc (srcset/picture winner) -> src attr ->
  // any srcset candidate. Scan cap: a hostile page with 100k imgs must not
  // stall the worker's awaited injection.
  const imgs = [...document.querySelectorAll('img')].slice(0, 2000);
  const img =
    imgs.find((i) => abs(i.currentSrc) === target) ||
    imgs.find((i) => abs(i.getAttribute('src') || '') === target) ||
    imgs.find((i) =>
      (i.getAttribute('srcset') || '')
        .split(',')
        .some((c) => abs(c.trim().split(/\s+/)[0]) === target)
    ) ||
    null;

  // Nearest preceding element matching sel, walking up from the image
  // (hop-capped on crafted DOMs).
  const nearestPrev = (sel: string): Element | null => {
    let hops = 0;

    for (
      let el: Element | null = img;
      el && el !== document.documentElement;
      el = el.parentElement
    ) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (++hops > 400) return null;
        if (sib.matches(sel)) return sib;
        const inner = sib.querySelectorAll(sel);
        if (inner.length) return inner[inner.length - 1];
      }
    }

    return null;
  };

  // schema.org JSON-LD: Place-like nodes and anything with geo coordinates.
  const ld: JsonLdPlace[] = [];

  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    if ((s.textContent || '').length > 200000) continue; // huge/hostile JSON-LD: skip, don't parse
    try {
      const nodes: Array<unknown> = [];
      const walk = (n: unknown): void => {
        if (nodes.length >= 2000) return; // bound traversal on crafted trees
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') {
          nodes.push(n);
          Object.values(n).forEach(walk);
        }
      };

      walk(JSON.parse(s.textContent || ''));

      for (const n of nodes) {
        const record = n as Record<string, any>;
        const types = ([] as Array<unknown>).concat(record['@type'] || []).map(String);
        if (
          record.geo ||
          types.some((t) =>
            /Place|TouristAttraction|TouristDestination|City|Landmark|LocalBusiness/i.test(t)
          )
        ) {
          // Every field bounded: a page controls all of these values.
          const country = record.address?.addressCountry;
          ld.push({
            types: types.slice(0, 3).map((t) => t.slice(0, 50).toWellFormed()),
            name: clean(record.name),
            locality: clean(record.address?.addressLocality),
            country: clean(country?.name || country),
            lat: Number.isFinite(Number(record.geo?.latitude)) ? Number(record.geo.latitude) : null,
            lon: Number.isFinite(Number(record.geo?.longitude))
              ? Number(record.geo.longitude)
              : null,
          });
        }
      }
    } catch {
      // malformed JSON-LD: skip block
    }
  }

  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const fileSlug = (u: string): string =>
    clean(
      safeDecode((u.split('/').pop() || '').split(/[?#]/)[0])
        .replace(/\.\w+$/, '')
        .replace(/[-_+]+/g, ' ')
    );

  const out: PageSignalData = {
    imgFound: !!img,
    alt: clean(img?.getAttribute('alt')),
    imgTitle: clean(img?.getAttribute('title')),
    figcaption: clean(img?.closest('figure')?.querySelector('figcaption')?.textContent),
    nearestHeading: clean(nearestPrev('h1,h2,h3,h4,h5,h6')?.textContent),
    nearestParagraph: clean(nearestPrev('p')?.textContent),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogSiteName: meta('meta[property="og:site_name"]'),
    docTitle: clean(document.title),
    metaDescription: meta('meta[name="description"]'),
    // Data minimization: no query strings/fragments ever leave the page; the
    // full URL stays local-only.
    canonical: clean(
      (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href?.split(
        /[?#]/
      )[0]
    ),
    pageHost: location.host,
    urlSlug: clean(
      safeDecode(location.pathname)
        .replace(/\.\w+$/, '')
        .replace(/[\/_-]+/g, ' ')
    ),
    imgFileSlug: fileSlug(target),
    jsonLd: ld.slice(0, 5),
  };
  // Hard total-size guard: a hostile page must not inflate the prompt or break
  // the storage write.
  if (JSON.stringify(out).length > 4096) {
    out.jsonLd = [];
    out.nearestParagraph = out.nearestParagraph.slice(0, 120).toWellFormed();
  }
  return out;
};
