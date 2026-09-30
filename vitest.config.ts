import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `tsc -p tsconfig.build.json` emits only src/, but a stale dist/ from an older
    // config would otherwise be picked up as a second copy of every test file. Those
    // copies share one database, so they would delete each other's fixtures mid-run.
    exclude: ['node_modules/**', 'dist/**'],
    // The suite mutates shared database state, so files must not race each other.
    // Within a file, tests run in declaration order, which several rely on.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
