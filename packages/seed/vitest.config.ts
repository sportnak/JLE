import { defineConfig } from 'vitest/config';

// The integration tests simulate weeks of study and run near the 5 s default under load.
export default defineConfig({ test: { testTimeout: 30_000 } });
