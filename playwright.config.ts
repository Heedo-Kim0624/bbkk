import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './outputs/browser/test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'outputs/browser/report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
