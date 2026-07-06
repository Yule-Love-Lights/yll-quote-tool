import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored design-tool editor (a faithful copy kept in the design tool's
    // own style for easy re-syncing — see src/components/design/editor-core).
    // tsc still type-checks it; only ESLint's style rules are skipped.
    "src/components/design/editor-core/**",
    // Nested agent worktrees (#110 W6-012): parallel build agents create
    // temporary git worktrees under .claude/worktrees/ that contain a full copy
    // of src/ — without this, a bare `npm run lint` double-lints them. Ignoring
    // here lets the plain gate command work without the `eslint src` workaround.
    ".claude/**",
  ]),
]);

export default eslintConfig;
