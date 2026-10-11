import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', channel: 'chromium', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }
  ],
  webServer: [
    { command: 'npm run dev -w backend', url: 'http://127.0.0.1:4100/api/health', env: { PORT: '4100', DB_PATH: ':memory:' }, reuseExistingServer: false },
    { command: 'npm run dev -w frontend -- --host 127.0.0.1 --port 5174 --strictPort', url: 'http://127.0.0.1:5174', env: { API_TARGET: 'http://127.0.0.1:4100' }, reuseExistingServer: false }
  ]
});
