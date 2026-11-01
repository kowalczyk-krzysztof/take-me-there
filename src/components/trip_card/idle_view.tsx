import styles from './trip_card.module.css';

interface Props {
  hint: string;
}

export const IdleView = ({ hint }: Props) => (
  <p id="idle-hint" className={styles.hint}>
    {hint}
  </p>
);
