import { beforeEach, describe, expect, it } from 'vitest';
import { collectSignals } from './collect_signals';

const PAGE_URL = 'https://example.com/travel/santorini-guide?ref=home#top';

const setPageUrl = (url: string): void => {
  const w = window as unknown as { happyDOM?: { setURL: (url: string) => void } };
  w.happyDOM?.setURL(url);
};

beforeEach(() => {
  setPageUrl(PAGE_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('collectSignals', () => {
  it('collects page and image signals for the clicked image', () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Santorini in spring">
      <meta property="og:description" content="White villages over blue water">
      <meta property="og:site_name" content="TravelBlog">
      <meta name="description" content="A week in Santorini">
      <link rel="canonical" href="https://example.com/travel/santorini-guide?ref=home">
      <script type="application/ld+json">
        {"@type": "TouristAttraction", "name": "Oia",
         "address": {"addressLocality": "Oia", "addressCountry": "Greece"},
         "geo": {"latitude": 36.46, "longitude": 25.37}}
      </script>
    `;
    document.title = 'Santorini guide';
    document.body.innerHTML = `
      <h2>Getting there</h2>
      <p>The ferry from Athens takes five hours.</p>
      <figure>
        <img src="https://cdn.example.com/oia.jpg" alt="Blue domes of Oia" title="Oia at sunset">
        <figcaption>Blue domes over the caldera</figcaption>
      </figure>
    `;

    const out = collectSignals('https://cdn.example.com/oia.jpg');

    expect(out.imgFound).toBe(true);
    expect(out.alt).toBe('Blue domes of Oia');
    expect(out.imgTitle).toBe('Oia at sunset');
    expect(out.figcaption).toBe('Blue domes over the caldera');
    expect(out.nearestHeading).toBe('Getting there');
    expect(out.nearestParagraph).toBe('The ferry from Athens takes five hours.');
    expect(out.ogTitle).toBe('Santorini in spring');
    expect(out.ogDescription).toBe('White villages over blue water');
    expect(out.ogSiteName).toBe('TravelBlog');
    expect(out.docTitle).toBe('Santorini guide');
    expect(out.metaDescription).toBe('A week in Santorini');
    expect(out.canonical).toBe('https://example.com/travel/santorini-guide');
    expect(out.pageHost).toBe('example.com');
    expect(out.urlSlug).toBe('travel santorini guide');
    expect(out.imgFileSlug).toBe('oia');
    expect(out.jsonLd).toHaveLength(1);
    expect(out.jsonLd[0]).toMatchObject({
      name: 'Oia',
      locality: 'Oia',
      country: 'Greece',
      lat: 36.46,
      lon: 25.37,
    });
  });

  it('matches srcset candidates and caps fields at 300 chars', () => {
    document.body.innerHTML = `
      <img src="https://cdn.example.com/small.jpg"
           srcset="https://cdn.example.com/big.jpg 2x, https://cdn.example.com/small.jpg 1x"
           alt="${'a'.repeat(500)}">
    `;

    const out = collectSignals('https://cdn.example.com/big.jpg');

    expect(out.imgFound).toBe(true);
    expect(out.alt).toHaveLength(300);
    expect(out.imgFileSlug).toBe('big');
  });

  it('tolerates a missing image', () => {
    document.body.innerHTML = `<p>No images here.</p>`;

    const out = collectSignals('https://cdn.example.com/gone.jpg');

    expect(out.imgFound).toBe(false);
    expect(out.alt).toBe('');
    expect(out.nearestHeading).toBe('');
    expect(out.jsonLd).toEqual([]);
  });

  it('enforces the total-size guard', () => {
    const node = {
      '@type': 'City',
      name: 'n'.repeat(300),
      address: { addressLocality: 'l'.repeat(300), addressCountry: 'c'.repeat(300) },
    };
    document.head.innerHTML = `<script type="application/ld+json">${JSON.stringify([
      node,
      node,
      node,
      node,
      node,
    ])}</script>`;
    document.body.innerHTML = `<p>${'q'.repeat(500)}</p><img src="https://cdn.example.com/x.jpg" alt="x">`;

    const out = collectSignals('https://cdn.example.com/x.jpg');

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4096);
    expect(out.jsonLd).toEqual([]);
    expect(out.nearestParagraph).toHaveLength(120);
  });

  it('skips hostile oversized JSON-LD blocks', () => {
    document.head.innerHTML = `<script type="application/ld+json">${'x'.repeat(200001)}</script>`;
    document.body.innerHTML = `<img src="https://cdn.example.com/x.jpg" alt="x">`;

    const out = collectSignals('https://cdn.example.com/x.jpg');

    expect(out.jsonLd).toEqual([]);
    expect(out.imgFound).toBe(true);
  });

  it('skips malformed JSON-LD blocks', () => {
    document.head.innerHTML = `<script type="application/ld+json">{"oops": }</script>`;
    document.body.innerHTML = `<img src="https://cdn.example.com/x.jpg" alt="x">`;

    const out = collectSignals('https://cdn.example.com/x.jpg');

    expect(out.jsonLd).toEqual([]);
    expect(out.imgFound).toBe(true);
  });

  it('stays serializable for executeScript', () => {
    expect(collectSignals.length).toBe(1);
    const source = collectSignals.toString();
    expect(source).not.toContain('require(');
    expect(source).not.toContain('import ');
  });
});
