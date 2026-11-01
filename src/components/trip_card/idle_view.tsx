import styles from './trip_card.module.css';

interface Props {
  hint: string;
}

export const IdleView = ({ hint }: Props) => <p className={styles.hint}>{hint}</p>;
