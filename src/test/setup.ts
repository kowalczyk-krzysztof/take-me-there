import { act } from 'react';
import { afterEach } from 'vitest';
import { cleanupRenderSync } from './render_sync';

afterEach(async () => {
  // Let trailing chains settle inside an act() scope.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanupRenderSync();
});
