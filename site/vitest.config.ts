import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config.js';

const config = mergeConfig(
  base,
  defineConfig({ test: { coverage: { enabled: false }, testTimeout: 60000 } }),
);
// Vite merges arrays by concatenation. Replace include AFTER the merge so site:test does not run
// the whole numerical suite a second time (the root ci command owns that independent gate).
config['test'] = { ...config['test'], include: ['site/test/**/*.test.ts'] };
export default config;
