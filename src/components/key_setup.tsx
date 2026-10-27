import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import styles from './key_setup.module.css';
import { msg } from '../utils/i18n';
import { emit } from '../utils/events';

const DASHBOARD_URL = 'https://dev.meta.ai';

export interface KeySaveRequestDetail {
  key: string;
  sessionOnly: boolean;
}

export interface ConsentDecisionDetail {
  agreed: boolean;
}

export interface SessionOnlyChangeDetail {
  checked: boolean;
}

export type NanoSectionState = 'hidden' | 'ready' | 'downloadable' | 'downloading' | 'failed';

export interface KeySetupCallbacks {
  onSave: (key: string) => void;
  onError: (text: string) => void;
  onSessionOnlyChange: (checked: boolean) => void;
  onNanoEnable: () => void;
  onConsentDecision: (agreed: boolean) => void;
  onDraftChange?: (draft: string) => void;
}

const NanoSection = ({
  nano, nanoInstead, nanoProgress, onNanoEnable,
}: {
  nano: NanoSectionState;
  nanoInstead: boolean;
  nanoProgress: number | null;
  onNanoEnable: () => void;
}) => {
  if (nano === 'hidden') {
    return null;
  }
  if (nano === 'downloading') {
    return (
      <div className={styles['nano-section']}>
        <p className={styles.hint} id="nano-hint">{msg('nanoDownloadHint')}</p>
        <progress
          id="nano-progress"
          max={100}
          value={nanoProgress === null ? undefined : Math.min(1, Math.max(0, nanoProgress)) * 100}
          aria-label={msg('nanoDownloading')}
        />
      </div>
    );
  }
  return (
    <div className={styles['nano-section']}>
      <p className={styles.hint} id="nano-hint">{msg('nanoDownloadHint')}</p>
      {nano === 'failed' ? <p className={styles.error}>{msg('nanoDownloadFail')}</p> : null}
      <button
        type="button"
        className={styles.secondary}
        aria-describedby="nano-hint"
        onClick={onNanoEnable}
      >
        {msg(nanoInstead ? 'nanoTryInstead' : 'nanoTry')}
      </button>
    </div>
  );
};

export const KeySetup = ({
  mode, pending, error, sessionOnly, nano, nanoInstead, nanoProgress, resetKey, callbacks,
}: {
  mode: 'setup' | 'consent';
  pending: boolean;
  error: string | null;
  sessionOnly: boolean;
  nano: NanoSectionState;
  nanoInstead: boolean;
  nanoProgress: number | null;
  resetKey: number;
  callbacks: KeySetupCallbacks;
}) => {
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (error !== null) {
      inputRef.current?.focus();
    }
  }, [error]);
  const attach = (el: HTMLDivElement | null): (() => void) | void => {
    if (!el) {
      return;
    }
    // Native listener: React's change tracking drops programmatic checked
    // sets, which callers use.
    const onChange = (event: Event): void => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement) || box.id !== 'session-only') {
        return;
      }
      callbacks.onSessionOnlyChange(box.checked);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  };
  return (
    <div className={styles.root} ref={attach}>
      {mode === 'consent' ? (
        <>
          <h2 tabIndex={-1}>{msg('consentTitle')}</h2>
          <p className={styles['consent-body']}>{msg('consentBody')}</p>
          <div className={styles['button-row']}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => callbacks.onConsentDecision(true)}
            >
              {msg('agreeButton')}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => callbacks.onConsentDecision(false)}
            >
              {msg('declineButton')}
            </button>
          </div>
        </>
      ) : (
        <form
          key={resetKey}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) {
              return;
            }
            const key = (inputRef.current?.value ?? '').trim();
            if (!key) {
              callbacks.onError(msg('keyErrorEmpty'));
              return;
            }
            callbacks.onSave(key);
          }}
        >
          <label className={styles['field-label']} htmlFor="key-input">{msg('keyLabel')}</label>
          <input
            id="key-input"
            ref={inputRef}
            type={revealed ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-describedby={error === null ? 'key-hint' : 'key-hint key-error'}
            aria-invalid={error === null ? undefined : 'true'}
            placeholder={msg('keyPlaceholder')}
            onChange={(event) => callbacks.onDraftChange?.(event.currentTarget.value)}
          />
          <p className={styles.hint} id="key-hint">{msg('keyHint')}</p>
          <p className={styles.dashboard}>
            <a href={DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
              {msg('dashboardLink')}
              <span className="visually-hidden">{msg('newTabSuffix')}</span>
            </a>
          </p>
          <p className={styles.error} id="key-error" hidden={error === null || undefined}>
            {error}
          </p>
          <label className={styles['checkbox-row']}>
            {/* Uncontrolled + keyed: a changed sessionOnly prop remounts
                with the new default; user toggles never re-render with a
                new value, so the DOM keeps the user's choice. */}
            <input
              type="checkbox"
              id="session-only"
              key={String(sessionOnly)}
              defaultChecked={sessionOnly}
            />
            <span>{msg('sessionOnlyLabel')}</span>
          </label>
          <div className={styles['button-row']}>
            <button
              type="submit"
              className={styles.primary}
              aria-disabled={pending || undefined}
            >
              {msg(pending ? 'validatingButton' : 'saveKeyButton')}
            </button>
            <button
              type="button"
              className={styles.secondary}
              aria-pressed={revealed ? 'true' : 'false'}
              onClick={() => flushSync(() => setRevealed((was) => !was))}
            >
              {msg(revealed ? 'hideKeyButton' : 'showKeyButton')}
            </button>
          </div>
          <NanoSection
            nano={nano}
            nanoInstead={nanoInstead}
            nanoProgress={nanoProgress}
            onNanoEnable={callbacks.onNanoEnable}
          />
          <p className={styles.notice}>{msg('securityNotice')}</p>
          <p className={styles.hygiene}>{msg('keyHygiene')}</p>
        </form>
      )}
    </div>
  );
};

export class KeySetupElement extends HTMLElement {
  private root: Root | null = null;
  private mode: 'setup' | 'consent' = 'setup';
  private sessionOnly = false;
  private pending = false;
  private error: string | null = null;
  private nano: NanoSectionState = 'hidden';
  private nanoInstead = false;
  private nanoProgress: number | null = null;
  private resetKey = 0;

  connectedCallback(): void {
    this.root ??= createRoot(this);
    this.render();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = null;
  }

  showSetup(): void {
    this.mode = 'setup';
    this.nano = 'hidden';
    this.nanoProgress = null;
    this.render();
  }

  showConsent(): void {
    this.mode = 'consent';
    this.render();
  }

  focusConsentHeading(): void {
    this.querySelector('h2')?.focus();
  }

  setPending(pending: boolean): void {
    this.pending = pending;
    this.render();
  }

  setError(text: string): void {
    this.error = text;
    this.render();
  }

  clearError(): void {
    this.error = null;
    this.render();
  }

  clear(): void {
    const input = this.querySelector<HTMLInputElement>('#key-input');
    if (input) {
      input.value = '';
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby', 'key-hint');
    }
    this.resetKey += 1;
    this.clearError();
    this.setPending(false);
  }

  setSessionOnly(checked: boolean): void {
    this.sessionOnly = checked;
    this.render();
  }

  getDraft(): KeySaveRequestDetail {
    const input = this.querySelector<HTMLInputElement>('#key-input');
    return { key: (input?.value ?? '').trim(), sessionOnly: this.sessionOnly };
  }

  setNano(state: NanoSectionState, opts: { instead?: boolean } = {}): void {
    this.nano = state;
    this.nanoInstead = opts.instead ?? false;
    if (state !== 'downloading') {
      this.nanoProgress = null;
    }
    this.render();
  }

  setNanoProgress(frac: number | null): void {
    this.nanoProgress = frac;
    this.render();
  }

  private render(): void {
    if (!this.root) {
      return;
    }
    const host = this;
    flushSync(() => {
      this.root?.render(
        <KeySetup
          mode={host.mode}
          pending={host.pending}
          error={host.error}
          sessionOnly={host.sessionOnly}
          nano={host.nano}
          nanoInstead={host.nanoInstead}
          nanoProgress={host.nanoProgress}
          resetKey={host.resetKey}
          callbacks={{
            onSave: (key) => {
              host.clearError();
              emit(host, 'key-save-request', { key, sessionOnly: host.sessionOnly } satisfies KeySaveRequestDetail);
            },
            onError: (text) => host.setError(text),
            onSessionOnlyChange: (checked) => {
              host.sessionOnly = checked;
              emit(host, 'session-only-change', { checked } satisfies SessionOnlyChangeDetail);
            },
            onNanoEnable: () => emit(host, 'nano-enable'),
            onConsentDecision: (agreed) => emit(host, 'consent-decision', { agreed } satisfies ConsentDecisionDetail),
          }}
        />,
      );
    });
  }
}

if (!customElements.get('key-setup')) {
  customElements.define('key-setup', KeySetupElement);
}
