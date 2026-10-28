import { msg } from '../../utils/i18n';
import { CACHE_TTL_CHOICES } from '../../settings_store';

interface Props {
  heading: string;
  ttlDays: number;
  cachePending: boolean;
  cacheResult: string | null;
  onClearCache: () => void;
}

export const DataSection = ({
  heading,
  ttlDays,
  cachePending,
  cacheResult,
  onClearCache,
}: Props) => (
  <>
    <h2 id="data-heading">{heading}</h2>
    <label className="field-row">
      <span id="retention-label">{msg('retentionLabel')}</span>
      <select id="retention-select" defaultValue={String(ttlDays)}>
        {CACHE_TTL_CHOICES.map((days) => (
          <option key={days} value={String(days)}>
            {msg(days === 1 ? 'retentionDay' : days === 30 ? 'retentionMonth' : 'retentionWeek')}
          </option>
        ))}
      </select>
    </label>
    <div className="button-row">
      <button id="clear-cache" type="button" disabled={cachePending} onClick={onClearCache}>
        {msg('clearCacheButton')}
      </button>
    </div>
    <p id="cache-result" role="status" hidden={cacheResult === null || undefined}>
      {cacheResult}
    </p>
  </>
);
