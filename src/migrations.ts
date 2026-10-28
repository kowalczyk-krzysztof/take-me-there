import { migrateBoard } from './board_store';
import { migrateSpend } from './pricing';
import { migrateSettings } from './settings_store';

const MIGRATIONS: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'settings', run: migrateSettings },
  { name: 'board', run: migrateBoard },
  { name: 'spend', run: migrateSpend },
];

// Ordered and idempotent: every step tolerates already-migrated records,
// and steps are isolated so one corrupt store cannot block the others.
// Consent and vault records are deliberately excluded: legacy consent has
// no timestamp to backfill and vault ciphertext must never be rewritten.
export const runUpdateMigrations = async (): Promise<void> => {
  for (const step of MIGRATIONS) {
    try {
      await step.run();
    } catch (err) {
      console.warn(`migration ${step.name} failed`, err);
    }
  }
};
