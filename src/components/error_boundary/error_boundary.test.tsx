import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './error_boundary';
import { renderSync } from '../../test/render_sync';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('error-boundary', () => {
  it('renders children when nothing throws', () => {
    const root = renderSync(
      <ErrorBoundary fallback={() => <p>fallback</p>}>
        <p>child</p>
      </ErrorBoundary>
    ).container;
    expect(root.querySelector('p')?.textContent).toBe('child');
  });

  it('shows the fallback and reports when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onCatch = vi.fn();
    const Bomb = (): never => {
      throw new Error('boom');
    };
    const root = renderSync(
      <ErrorBoundary fallback={() => <p>fallback</p>} onCatch={onCatch}>
        <Bomb />
      </ErrorBoundary>
    ).container;
    expect(root.querySelector('p')?.textContent).toBe('fallback');
    expect(onCatch).toHaveBeenCalledTimes(1);
  });

  it('retries the children after reset', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let armed = true;
    const Flaky = (): ReactNode => {
      if (armed) {
        throw new Error('boom');
      }
      return <p>recovered</p>;
    };
    const rendered = renderSync(
      <ErrorBoundary
        fallback={(reset) => (
          <button
            type="button"
            onClick={() => {
              armed = false;
              reset();
            }}
          />
        )}
      >
        <Flaky />
      </ErrorBoundary>
    );
    expect(rendered.container.querySelector('button')).not.toBeNull();
    flushSync(() => {
      (rendered.container.querySelector('button') as HTMLButtonElement).click();
    });
    expect(rendered.container.querySelector('p')?.textContent).toBe('recovered');
  });
});
