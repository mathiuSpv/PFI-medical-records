// Config mínima: apunta al dev server ya levantado (npm run dev, :5173) y al
// BFF (:3001) — no arranca servidores propios porque ambos dependen de la red
// Fabric + IPFS arriba, que Playwright no puede orquestar.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
});
