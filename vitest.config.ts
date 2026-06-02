import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirror the `@/* -> ./src/*` path alias from tsconfig.json so tests can
// import modules that use the project's `@/` convention (Vitest doesn't
// read tsconfig `paths` on its own). Regex-anchored to `@/` so scoped
// npm packages like `@anthropic-ai/sdk` are left untouched.
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${srcDir}/` }],
  },
});
