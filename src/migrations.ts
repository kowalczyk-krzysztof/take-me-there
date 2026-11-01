import { migrateSpend } from './pricing';
import { migrateCache } from './result_cache';
import { migrateSettings } from './settings_store';

const MIGRATIONS: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'settings', run: migrateSettings },
  { name: 'spend', run: migrateSpend },
  { name: 'cache', run: migrateCache },
];

export interface MigrationStepResult {
  name: string;
  ok: boolean;
  error?: string;
}

// Steps are isolated so one corrupt store cannot block the others; vault ciphertext is excluded and never rewritten.
export const runUpdateMigrations = async (): Promise<MigrationStepResult[]> => {
  const results: MigrationStepResult[] = [];

  for (const step of MIGRATIONS) {
    try {
      await step.run();
      results.push({ name: step.name, ok: true });
    } catch (err) {
      console.warn(`migration ${step.name} failed`, err);
      results.push({
        name: step.name,
        ok: false,
        error: err instanceof Error ? err.message : 'migration failed',
      });
    }
  }

  return results;
};
