import styles from './trip_card.module.css';

interface Props {
  hint: string;
  shortcut: string;
}

export const IdleView = ({ hint, shortcut }: Props) => (
  <>
    <p className={styles.hint}>{hint}</p>
    <p className={styles.shortcut}>{shortcut}</p>
  </>
);
