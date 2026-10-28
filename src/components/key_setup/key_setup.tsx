import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './key_setup.module.css';
import { msg } from '../../utils/i18n';

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

export interface KeySetupCallbacks {
  onSave: (key: string) => void;
  onError: (text: string) => void;
  onSessionOnlyChange: (checked: boolean) => void;
  onConsentDecision: (agreed: boolean) => void;
  onDraftChange?: (draft: string) => void;
}

interface Props {
  mode: 'setup' | 'consent';
  pending: boolean;
  error: string | null;
  sessionOnly: boolean;
  resetKey: number;
  callbacks: KeySetupCallbacks;
}

export const KeySetup = ({
  mode, pending, error, sessionOnly, resetKey, callbacks,
}: Props) => {
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
          <p className={styles.notice}>{msg('securityNotice')}</p>
          <p className={styles.hygiene}>{msg('keyHygiene')}</p>
        </form>
      )}
    </div>
  );
};

