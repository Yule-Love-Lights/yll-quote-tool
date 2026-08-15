import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Ledger #261: the `_`-prefix unused-arg convention (used ~24 places, e.g.
  // inbox/store.test.ts's mock signatures) was never actually exempted —
  // eslint-config-next/typescript sets @typescript-eslint/no-unused-vars to
  // `warn` with NO ignore patterns, so every `_`-prefixed parameter has been
  // warning since the convention started. This makes the convention real.
  // Deliberately argsIgnorePattern ONLY (the row's exact scope): a `_`-prefixed
  // unused VARIABLE still warns, which is honest — a variable you bound and
  // never read is usually a leftover, while an unused arg is often required
  // by a callback signature.
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
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
  // ---------------------------------------------------------------------
  // Placeholder-rate guardrail (P4P Track A).
  //
  // Every jobs.budgeted_hours / jobs.labor_revenue_cents value in production
  // was computed from PLACEHOLDER production rates, flagged per-row by
  // jobs.rates_are_placeholder. Reading those columns directly is how an
  // invented number ends up on a screen, or in a paycheck, looking real.
  //
  // Read them through src/lib/laborPlan.ts instead: readLaborPlan() returns a
  // tagged union you have to narrow, and requireRealLaborPlan() throws rather
  // than handing back a placeholder figure. This rule is what makes that door
  // the only one — without it, the accessor is a suggestion.
  //
  // Allowlisted below: laborPlan.ts itself (it is the door), jobs.ts (the row
  // mapper, which necessarily names the columns), and tests (they build
  // fixtures). Widen the allowlist only after reading that module's doc block.
  //
  // KNOWN LIMIT, stated so nobody mistakes this for airtight: a fully dynamic
  // key (`const k = someRuntimeValue; job[k]`) cannot be caught by a static
  // selector. Literal dot access, literal bracket access, destructuring, and
  // literal-keyed object properties are all covered. The rule raises the cost
  // of going around the accessor; it does not make it impossible.
  // ---------------------------------------------------------------------
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/lib/laborPlan.ts",
      "src/lib/jobs.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[computed=false] > Identifier.property[name=/^(budgeted_hours|labor_revenue_cents)$/]",
          message:
            "Do not read a job's raw labor columns. Use readLaborPlan() or requireRealLaborPlan() from src/lib/laborPlan.ts - every stored value is currently computed from placeholder production rates, and those helpers force you to handle that instead of showing an invented number as real.",
        },
        {
          // Bracket access with a string literal: job["budgeted_hours"]. The
          // dot-notation selector above uses computed=false and does NOT catch
          // this - the S58 wrap review's technical lens proved it with a probe
          // file that linted clean.
          selector:
            "MemberExpression[computed=true] > Literal[value=/^(budgeted_hours|labor_revenue_cents)$/]",
          message:
            "Do not read a job's raw labor columns, including by bracket access. Use readLaborPlan() or requireRealLaborPlan() from src/lib/laborPlan.ts - every stored value is currently computed from placeholder production rates.",
        },
        {
          selector:
            "Property > Identifier.key[name=/^(budgeted_hours|labor_revenue_cents)$/]",
          message:
            "Do not destructure or rebuild a job's raw labor columns outside the row mapper. Use readLaborPlan() or requireRealLaborPlan() from src/lib/laborPlan.ts - every stored value is currently computed from placeholder production rates.",
        },
        {
          // String-literal property key: { "budgeted_hours": x }. The Identifier
          // selector above only matches bare keys.
          selector:
            "Property > Literal.key[value=/^(budgeted_hours|labor_revenue_cents)$/]",
          message:
            "Do not destructure or rebuild a job's raw labor columns outside the row mapper. Use readLaborPlan() or requireRealLaborPlan() from src/lib/laborPlan.ts - every stored value is currently computed from placeholder production rates.",
        },
      ],
    },
  },
]);

export default eslintConfig;
