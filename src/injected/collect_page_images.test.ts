// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectPageImages } from './collect_page_images';

const PAGE_URL = 'https://example.com/listicle/hidden-gems';

const setPageUrl = (url: string): void => {
  const w = window as unknown as { happyDOM?: { setURL: (url: string) => void } };
  w.happyDOM?.setURL(url);
};

interface ImgStubs {
  src: string;
  currentSrc?: string;
  width?: number;
  height?: number;
  alt?: string;
}

const addImg = (parent: HTMLElement, stubs: ImgStubs): HTMLImageElement => {
  const img = document.createElement('img');
  img.setAttribute('src', stubs.src);
  if (stubs.currentSrc !== undefined) {
    Object.defineProperty(img, 'currentSrc', { value: stubs.currentSrc, configurable: true });
  }
  if (stubs.alt !== undefined) {
    img.setAttribute('alt', stubs.alt);
  }
  const width = stubs.width ?? 640;
  const height = stubs.height ?? 480;
  img.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  parent.append(img);
  return img;
};

beforeEach(() => {
  setPageUrl(PAGE_URL);
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('collectPageImages', () => {
  it('harvests rendered-large images with captions and headings', () => {
    const heading = document.createElement('h2');
    heading.textContent = 'Santorini sunsets';
    document.body.append(heading);
    addImg(document.body, {
      src: 'https://cdn.example.com/santorini.jpg',
      alt: 'Blue domes over the caldera',
    });

    const out = collectPageImages();

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      url: 'https://cdn.example.com/santorini.jpg',
      caption: 'Blue domes over the caldera',
      heading: 'Santorini sunsets',
      width: 640,
      height: 480,
    });
  });

  it('filters icons, hidden, and non-web schemes', () => {
    addImg(document.body, { src: 'https://cdn.example.com/big.jpg' });
    addImg(document.body, { src: 'https://cdn.example.com/icon.png', width: 32, height: 32 });
    addImg(document.body, { src: 'https://cdn.example.com/hidden.jpg', width: 0, height: 0 });
    addImg(document.body, { src: 'blob:https://example.com/aaa' });

    const out = collectPageImages();

    expect(out.map((image) => image.url)).toEqual(['https://cdn.example.com/big.jpg']);
  });

  it('prefers currentSrc and dedupes query variants', () => {
    addImg(document.body, {
      src: 'https://cdn.example.com/a.jpg?size=small',
      currentSrc: 'https://cdn.example.com/a.jpg?size=large',
    });
    addImg(document.body, { src: 'https://cdn.example.com/a.jpg?size=thumb' });

    const out = collectPageImages();

    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://cdn.example.com/a.jpg?size=large');
  });

  it('falls back to figcaption and caps fields at 300 chars', () => {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = `x${'y'.repeat(500)}`;
    figure.append(caption);
    document.body.append(figure);
    addImg(figure, { src: 'https://cdn.example.com/fig.jpg' });

    const out = collectPageImages();

    expect(out[0].caption).toHaveLength(300);
  });

  it('sorts largest-first and caps the harvest at twelve', () => {
    for (let i = 0; i < 15; i++) {
      addImg(document.body, {
        src: `https://cdn.example.com/img${i}.jpg`,
        width: 300 + i * 10,
        height: 300,
      });
    }

    const out = collectPageImages();

    expect(out).toHaveLength(12);
    expect(out[0].url).toBe('https://cdn.example.com/img14.jpg');
    expect(out[11].url).toBe('https://cdn.example.com/img3.jpg');
  });

  it('keeps small inline images but drops huge ones and guards the total', () => {
    addImg(document.body, { src: `data:image/jpeg,${'a'.repeat(1000)}` });
    addImg(document.body, { src: `data:image/jpeg,${'b'.repeat(200000)}` });

    const out = collectPageImages();

    expect(out.map((image) => image.url.slice(0, 16))).toEqual(['data:image/jpeg,']);
  });
});
