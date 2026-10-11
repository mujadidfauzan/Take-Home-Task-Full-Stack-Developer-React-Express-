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
    { command: 'npm run e2e:server -w backend', url: 'http://127.0.0.1:4100/api/health', env: { PORT: '4100', MONGO_DB_NAME: 'mini_tasks_e2e', MONGODB_URI: 'mongodb://mini_app:dev_app_password@127.0.0.1:27017/mini_tasks_e2e?authSource=mini_tasks_e2e&replicaSet=rs0&directConnection=true' }, reuseExistingServer: false },
    { command: 'npm run dev -w frontend -- --host 127.0.0.1 --port 5174 --strictPort', url: 'http://127.0.0.1:5174', env: { API_TARGET: 'http://127.0.0.1:4100' }, reuseExistingServer: false }
  ]
});
