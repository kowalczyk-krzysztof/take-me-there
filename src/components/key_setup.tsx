import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { injectComponentStyles } from './shared_styles';
import elementCss from './key_setup.css?raw';

injectComponentStyles('key-setup', elementCss);

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

const msg = (key: string, subs?: string | string[]): string =>
  chrome.i18n.getMessage(key, subs);

const emit = (host: HTMLElement, name: string, detail?: unknown): void => {
  host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
};

const NanoSection = ({
  host, nano, nanoInstead, nanoProgress,
}: {
  host: HTMLElement;
  nano: NanoSectionState;
  nanoInstead: boolean;
  nanoProgress: number | null;
}) => {
  if (nano === 'hidden') {
    return null;
  }
  if (nano === 'downloading') {
    return (
      <div className="nano-section">
        <p className="hint" id="nano-hint">{msg('nanoDownloadHint')}</p>
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
    <div className="nano-section">
      <p className="hint" id="nano-hint">{msg('nanoDownloadHint')}</p>
      {nano === 'failed' ? <p className="error">{msg('nanoDownloadFail')}</p> : null}
      <button
        type="button"
        className="secondary"
        aria-describedby="nano-hint"
        onClick={() => emit(host, 'nano-enable')}
      >
        {msg(nanoInstead ? 'nanoTryInstead' : 'nanoTry')}
      </button>
    </div>
  );
};

export class KeySetupElement extends HTMLElement {
  private root: Root | null = null;
  private view: 'setup' | 'consent' = 'setup';
  private sessionOnly = false;
  private pending = false;
  private error: string | null = null;
  private revealed = false;
  private nano: NanoSectionState = 'hidden';
  private nanoInstead = false;
  private nanoProgress: number | null = null;

  connectedCallback(): void {
    this.root ??= createRoot(this);
    this.addEventListener('change', this.onChange);
    this.render();
  }

  disconnectedCallback(): void {
    this.removeEventListener('change', this.onChange);
    this.root?.unmount();
    this.root = null;
  }

  // Native listener: React's change tracking drops programmatic checked
  // sets, which callers use. No re-render: the DOM already shows the value.
  private onChange = (event: Event): void => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.id !== 'session-only') {
      return;
    }
    this.sessionOnly = box.checked;
    emit(
      this,
      'session-only-change',
      { checked: box.checked } satisfies SessionOnlyChangeDetail,
    );
  };

  showSetup(): void {
    this.view = 'setup';
    this.nano = 'hidden';
    this.nanoProgress = null;
    this.render();
  }

  showConsent(): void {
    this.view = 'consent';
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
    this.querySelector<HTMLInputElement>('#key-input')?.focus();
  }

  clearError(): void {
    this.error = null;
    this.render();
  }

  clear(): void {
    const input = this.querySelector<HTMLInputElement>('#key-input');
    if (input) {
      input.value = '';
    }
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
    // Reconciliation keeps the input node (and its draft) across renders.
    this.render();
  }

  setNanoProgress(frac: number | null): void {
    this.nanoProgress = frac;
    this.render();
  }

  private inputValue(): string {
    return this.querySelector<HTMLInputElement>('#key-input')?.value ?? '';
  }

  private render(): void {
    if (!this.root) {
      return;
    }
    const host = this;
    flushSync(() => {
      this.root?.render(
        this.view === 'consent' ? (
          <>
            <h2 tabIndex={-1}>{msg('consentTitle')}</h2>
            <p className="consent-body">{msg('consentBody')}</p>
            <div className="button-row">
              <button
                type="button"
                className="primary"
                onClick={() => emit(host, 'consent-decision', { agreed: true } satisfies ConsentDecisionDetail)}
              >
                {msg('agreeButton')}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => emit(host, 'consent-decision', { agreed: false } satisfies ConsentDecisionDetail)}
              >
                {msg('declineButton')}
              </button>
            </div>
          </>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (this.pending) {
                return;
              }
              const key = this.inputValue().trim();
              if (!key) {
                this.setError(msg('keyErrorEmpty'));
                return;
              }
              this.clearError();
              emit(host, 'key-save-request', { key, sessionOnly: this.sessionOnly } satisfies KeySaveRequestDetail);
            }}
          >
            <label className="field-label" htmlFor="key-input">{msg('keyLabel')}</label>
            <input
              id="key-input"
              type={this.revealed ? 'text' : 'password'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={this.error === null ? 'key-hint' : 'key-hint key-error'}
              aria-invalid={this.error === null ? undefined : 'true'}
              placeholder={msg('keyPlaceholder')}
            />
            <p className="hint" id="key-hint">{msg('keyHint')}</p>
            <p className="dashboard">
              <a href={DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
                {msg('dashboardLink')}
                <span className="visually-hidden">{msg('newTabSuffix')}</span>
              </a>
            </p>
            <p className="error" id="key-error" hidden={this.error === null || undefined}>
              {this.error}
            </p>
            <label className="checkbox-row">
              {/* Uncontrolled + keyed: programmatic setSessionOnly
                  remounts with the new default; user toggles never
                  re-render, so the DOM keeps the user's value. */}
              <input
                type="checkbox"
                id="session-only"
                key={String(this.sessionOnly)}
                defaultChecked={this.sessionOnly}
              />
              <span>{msg('sessionOnlyLabel')}</span>
            </label>
            <div className="button-row">
              <button
                type="submit"
                className="primary"
                aria-disabled={this.pending || undefined}
              >
                {msg(this.pending ? 'validatingButton' : 'saveKeyButton')}
              </button>
              <button
                type="button"
                className="secondary"
                aria-pressed={this.revealed ? 'true' : 'false'}
                onClick={() => {
                  this.revealed = !this.revealed;
                  this.render();
                }}
              >
                {msg(this.revealed ? 'hideKeyButton' : 'showKeyButton')}
              </button>
            </div>
            <NanoSection
              host={host}
              nano={this.nano}
              nanoInstead={this.nanoInstead}
              nanoProgress={this.nanoProgress}
            />
            <p className="notice">{msg('securityNotice')}</p>
            <p className="hygiene">{msg('keyHygiene')}</p>
          </form>
        ),
      );
    });
  }
}

if (!customElements.get('key-setup')) {
  customElements.define('key-setup', KeySetupElement);
}
