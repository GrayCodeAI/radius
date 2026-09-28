/**
 * ESLint flat config — Radius.
 *
 * Scope is deliberately narrow: `tseslint.configs.strictTypeChecked` with type information.
 *
 * Why type-aware linting rather than the faster untyped preset: this codebase's entire product
 * claim is that a record is durable before `append()` resolves. An unawaited promise, a promise
 * returned where a value is expected, or an `await` on a non-thenable is not a style nit here —
 * it is a silently lost write. Those are exactly the rules that require type information, so
 * paying for a type-aware lint pass is the point rather than the overhead.
 *
 * `eslint-config-prettier` is spread LAST on purpose: formatting is owned by Prettier, and the
 * two tools must never disagree about where a line break goes.
 */
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/out/**",
      // Vendored verbatim, never linted or reformatted. See AGENTS.md non-negotiable 4 and
      // docs/VENDORING.md — editing this tree is a license violation, and a lint --fix would
      // do exactly that.
      "vendor/**",
    ],
  },

  // Plain JS/MJS: the repository's own check scripts. Node globals, ESM.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // TypeScript, with types. See the note above for why this is not the untyped preset.
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        // Pointed at both the build tsconfig (src) and the test tsconfig (src + test). The
        // project *service* would only auto-discover the nearest `tsconfig.json`, which
        // deliberately excludes test/ so `tsc -p tsconfig.json` does not compile tests into
        // dist — that left the test file with no project at all, i.e. unlinted and untyped.
        project: [
          "./apps/*/tsconfig.json",
          "./apps/*/tsconfig.test.json",
          "./packages/*/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Restated explicitly so the safety-critical ones cannot be lost if the preset is ever
      // downgraded. Each maps to a real hazard in this repo rather than to a general preference.
      "@typescript-eslint/no-floating-promises": "error", // a dropped append() is a lost record
      "@typescript-eslint/await-thenable": "error", // awaiting a non-promise hides a dropped write
      "@typescript-eslint/require-await": "error", // a fake async is usually a missing await
      "@typescript-eslint/no-misused-promises": "error", // promise in a position that will not await

      // Numeric interpolation in a message is deliberate here — `seq 41` is the thing an
      // operator needs to see. The rule exists to catch `[object Object]` in logs, and a number
      // can never produce that, so it is pure noise on this codebase.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],

      // The default flags every `() => resolve()` in a promise executor or fs callback. Those are
      // the idiomatic spelling and adding braces to each is noise, not clarity. The block-bodied
      // case (`return reject(err)`) is still reported and still worth fixing.
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
    },
  },

  // node:test's `test()`, `describe()`, `it()` and the hooks all return promises the runner
  // owns; the documented usage is to call them without awaiting. That is a floating promise by
  // construction, so the rule has to be told rather than silenced wholesale. Scoped to test
  // files only — the same mistake in src/ is still a hard error, which is the whole point of
  // keeping the rule on everywhere else.
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            "test",
            "describe",
            "it",
            "beforeEach",
            "afterEach",
            "before",
            "after",
          ].map((name) => ({ from: "package", name, package: "node:test" })),
        },
      ],
    },
  },

  prettier,
);
