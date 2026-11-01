import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';

interface Props {
  hint: string;
}

export const IdleView = ({ hint }: Props) => (
  <>
    <p className={styles.hint}>{hint}</p>
    <p className={styles.scanHint}>{msg('panelScanHint')}</p>
  </>
);
