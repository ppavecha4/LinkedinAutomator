import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Match both `*.test.ts` and the Session-8-style `test_*.ts` filenames.
    include: ['tests/**/*.test.ts', 'tests/**/test_*.ts'],
    testTimeout: 15_000,
  },
});
