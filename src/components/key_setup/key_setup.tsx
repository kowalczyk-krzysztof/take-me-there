import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import styles from './key_setup.module.css';
import { msg } from '../../utils/i18n';
import { ExternalLink } from '../external_link/external_link';

const DASHBOARD_URL = 'https://dev.meta.ai';

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
  laterNote?: string;
  callbacks: KeySetupCallbacks;
}

export const KeySetup = ({
  mode,
  pending,
  error,
  sessionOnly,
  resetKey,
  laterNote,
  callbacks,
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
          <label className={styles['field-label']} htmlFor="key-input">
            {msg('keyLabel')}
          </label>
          <div className={styles['input-row']}>
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
            <button
              type="button"
              className={styles.secondary}
              aria-controls="key-input"
              onClick={() => flushSync(() => setRevealed((was) => !was))}
            >
              {msg(revealed ? 'hideKeyButton' : 'showKeyButton')}
            </button>
          </div>
          <p className={styles.hint} id="key-hint">
            {msg('keyHintPrefix')}
            <ExternalLink href={DASHBOARD_URL}>{msg('keyHintDashboard')}</ExternalLink>.
          </p>
          <p
            className={styles.error}
            id="key-error"
            role="alert"
            hidden={error === null || undefined}
          >
            {error}
          </p>
          <label className={styles['checkbox-row']}>
            {/* Keyed remount picks up prop changes; user toggles never re-render, so the DOM keeps the user's choice. */}
            <input
              type="checkbox"
              id="session-only"
              key={String(sessionOnly)}
              defaultChecked={sessionOnly}
            />
            <span>{msg('sessionOnlyLabel')}</span>
          </label>
          {laterNote ? (
            <p className={styles.hint} id="key-later">
              {laterNote}
            </p>
          ) : null}
          <div className={styles['button-row']}>
            <button type="submit" className={styles.primary} aria-disabled={pending || undefined}>
              {msg(pending ? 'validatingButton' : 'saveKeyButton')}
            </button>
          </div>
          <p className={styles.notice}>{msg('securityNotice')}</p>
          <p className={styles.hygiene}>
            {msg('keyHygienePrefix')}
            <ExternalLink href={DASHBOARD_URL}>{msg('keyHintDashboard')}</ExternalLink>.
          </p>
        </form>
      )}
    </div>
  );
};
