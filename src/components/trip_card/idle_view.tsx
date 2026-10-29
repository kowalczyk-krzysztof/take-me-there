import styles from './trip_card.module.css';
import { msg } from '../../utils/i18n';

interface Props {
  hint: string;
  shortcut: string;
}

export const IdleView = ({ hint, shortcut }: Props) => (
  <>
    <p className={styles.hint}>{hint}</p>
    <p className={styles.scanHint}>{msg('panelScanHint')}</p>
    <p className={styles.shortcut}>{shortcut}</p>
  </>
);
