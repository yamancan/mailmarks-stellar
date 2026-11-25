import { defineConfig } from '@playwright/test';

// Pinned to 1.62.1, whose Chromium build (chromium-1234) is installed on this host.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium', trace: 'retain-on-failure' },
  // The one local command: builds first (prepreview), then serves web/dist.
  webServer: { command: 'npm run preview', url: 'http://localhost:4173', reuseExistingServer: false, timeout: 120_000 },
});
