import { msg } from '../../utils/i18n';

interface Props {
  heading: string;
  imageOnly: boolean;
  skipWebSearch: boolean;
  failed: boolean;
  onMode: (mode: 'imageOnly' | 'skipWebSearch', checked: boolean) => void;
  onRetry: () => void;
}

export const ModesSection = ({
  heading,
  imageOnly,
  skipWebSearch,
  failed,
  onMode,
  onRetry,
}: Props) => (
  <>
    <h2 id="modes-heading">{heading}</h2>
    {failed ? (
      <>
        <p id="modes-error" role="alert">
          {msg('settingsLoadFailed')}
        </p>
        <div className="button-row">
          <button type="button" onClick={onRetry}>
            {msg('retryButton')}
          </button>
        </div>
      </>
    ) : (
      <>
        <label className="checkbox-row">
          <input
            id="image-only"
            type="checkbox"
            checked={imageOnly}
            onChange={(event) => onMode('imageOnly', event.target.checked)}
          />
          <span>{msg('imageOnlyLabel')}</span>
        </label>
        <label className="checkbox-row">
          <input
            id="skip-search"
            type="checkbox"
            checked={skipWebSearch}
            onChange={(event) => onMode('skipWebSearch', event.target.checked)}
          />
          <span>{msg('skipSearchLabel')}</span>
        </label>
      </>
    )}
  </>
);
