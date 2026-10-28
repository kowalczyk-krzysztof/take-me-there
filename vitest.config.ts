import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    css: {
      modules: {
        classNameStrategy: 'non-scoped',
      },
    },
  },
});
