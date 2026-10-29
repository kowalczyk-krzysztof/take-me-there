// Markdown-lite renderer for model output: real semantic elements built
// with createElement, model strings inserted ONLY as text nodes. Blocks
// render progressively into the fixed guide box at blank-line boundaries,
// so half-open structures never strand.
export const MAX_GUIDE_CHARS = 20000;

// Offset of the first rendered heading, or -1 when the source holds none
// yet. The run holds back everything before it, so model
// throat-clearing ("I'll research X for you…") never reaches the reader;
// only the final result renders. Glued markers ("…guide.## Place", which
// models emit without a newline) count, single hashes do not (C# prose).
export const findGuideStart = (source: string): number => {
  let offset = 0;

  for (const line of source.split('\n')) {
    if (/^#{1,6}\s+\S/.test(line)) {
      return offset;
    }

    const mid = /#{2,6}\s+\S/.exec(line);

    if (mid) {
      return offset + mid.index;
    }

    offset += line.length + 1;
  }

  return -1;
};

// Progressive block state: completed Markdown blocks render as they
// arrive while the preamble hold-back and the trailing partial block stay
// back. Block granularity (never per token) bounds re-renders, and the
// final finish() renders whatever remains, so output matches one-shot.
export interface GuideProgress {
  started: boolean;
  flushed: number;
}

export const createGuideProgress = (): GuideProgress => ({ started: false, flushed: 0 });

export const pushGuideProgress = (
  renderer: GuideRenderer,
  progress: GuideProgress,
  source: string
): void => {
  const start = findGuideStart(source);

  if (start < 0) {
    return;
  }

  if (!progress.started) {
    progress.started = true;
    progress.flushed = start;
  }

  const rest = source.slice(progress.flushed);
  const boundary = rest.lastIndexOf('\n\n');

  if (boundary <= 0) {
    return;
  }

  renderer.push(rest.slice(0, boundary));
  progress.flushed += boundary;
};

export const finishGuideProgress = (
  renderer: GuideRenderer,
  progress: GuideProgress,
  source: string
): void => {
  if (!progress.started) {
    const start = findGuideStart(source);

    renderer.push(start >= 0 ? source.slice(start) : source);
  } else {
    renderer.push(source.slice(progress.flushed));
  }

  renderer.finish();
};

export interface GuideRenderer {
  push(text: string): void;
  finish(): void;
  readonly truncated: boolean;
  readonly charCount: number;
}

export const createGuideRenderer = (
  container: HTMLElement,
  truncatedNotice: string,
  maxChars: number = MAX_GUIDE_CHARS
): GuideRenderer => {
  let buffer = '';

  let finished = false;

  let wasTruncated = false;

  const render = (): void => {
    container.replaceChildren();

    const visible = buffer.length > maxChars ? buffer.slice(0, maxChars) : buffer;

    if (visible.length < buffer.length) {
      wasTruncated = true;
    }

    renderBlocks(container, visible);

    if (wasTruncated) {
      const note = document.createElement('p');
      note.className = 'guide-truncated';
      note.textContent = truncatedNotice;
      container.append(note);
    }
  };

  return {
    push(text: string): void {
      if (finished) {
        return;
      }
      buffer += text;
      render();
    },
    finish(): void {
      finished = true;
      render();
    },
    get truncated(): boolean {
      return wasTruncated;
    },
    get charCount(): number {
      return buffer.length;
    },
  };
};

const renderBlocks = (container: HTMLElement, text: string): void => {
  const lines = text.split('\n');

  let paragraph: string[] = [];

  let list: HTMLUListElement | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }

    const p = document.createElement('p');
    renderInline(p, paragraph.join(' '));
    container.append(p);
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      flushParagraph();
      list = null;

      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);

    if (heading) {
      flushParagraph();
      list = null;

      const el = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
      renderInline(el, heading[2]);
      container.append(el);

      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);

    if (bullet) {
      flushParagraph();

      if (!list) {
        list = document.createElement('ul');
        container.append(list);
      }

      const item = document.createElement('li');
      renderInline(item, bullet[1]);
      list.append(item);

      continue;
    }
    list = null;
    paragraph.push(line);
  }
  flushParagraph();
};

const renderInline = (parent: HTMLElement, text: string): void => {
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);

    if (bold) {
      const strong = document.createElement('strong');
      strong.textContent = bold[1];
      parent.append(strong);
    } else if (part !== '') {
      parent.append(document.createTextNode(part));
    }
  }
};
