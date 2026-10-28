import { useRef } from 'react';
import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';
import type { CompareOptionView } from './trip_card';

interface Props {
  options: CompareOptionView[];
  onCompare: (value: string) => void;
}

export const CompareRow = ({ options, onCompare }: Props) => {
  const selectRef = useRef<HTMLSelectElement>(null);
  const empty = options.length === 0;

  return (
    <div className={styles['compare-row']}>
      <label>
        {msg('compareLabel')}
        <select ref={selectRef} disabled={empty || undefined}>
          {empty ? (
            <option value="">{msg('compareEmpty')}</option>
          ) : (
            options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))
          )}
        </select>
      </label>
      <button
        type="button"
        className="compare-go"
        disabled={empty || undefined}
        onClick={() => {
          if (empty) {
            return;
          }
          onCompare(selectRef.current?.value ?? '');
        }}
      >
        {msg('compareGo')}
      </button>
    </div>
  );
};
