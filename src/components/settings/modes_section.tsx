import { msg } from '../../utils/i18n';

interface Props {
  heading: string;
  imageOnly: boolean;
  skipWebSearch: boolean;
}

export const ModesSection = ({ heading, imageOnly, skipWebSearch }: Props) => (
  <>
    <h2 id="modes-heading">{heading}</h2>
    <label className="checkbox-row" id="image-only-row">
      <input type="checkbox" id="image-only" defaultChecked={imageOnly} />
      <span id="image-only-label">{msg('imageOnlyLabel')}</span>
    </label>
    <label className="checkbox-row" id="skip-search-row">
      <input type="checkbox" id="skip-search" defaultChecked={skipWebSearch} />
      <span id="skip-search-label">{msg('skipSearchLabel')}</span>
    </label>
  </>
);
