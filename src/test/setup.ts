import { act } from 'react';
import { afterEach } from 'vitest';
import { cleanupRenderSync } from './render_sync';

afterEach(async () => {
  // Let trailing store chains settle while an act() scope is open so the
  // updates they schedule are attributed instead of warning.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanupRenderSync();
});
