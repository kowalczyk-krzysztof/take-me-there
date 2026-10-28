import { afterEach } from 'vitest';
import { cleanupRenderSync } from './render_sync';

afterEach(() => {
  cleanupRenderSync();
});
