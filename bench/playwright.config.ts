import { defineConfig } from '@playwright/test';

/** The replay bench: `npm run bench` (see bench/README.md). Separate from the Grafana e2e tests. */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.bench\.ts/,
  timeout: 120_000,
  fullyParallel: true,
  reporter: [['list']],
  outputDir: './results',
  use: { baseURL: 'http://127.0.0.1:5181' },
  webServer: {
    command: 'node server.mjs',
    cwd: __dirname,
    url: 'http://127.0.0.1:5181/pages/player.html',
    reuseExistingServer: true,
  },
});
