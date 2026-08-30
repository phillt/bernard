import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  },

  // Base recommended rules for all TS files
  ...tseslint.configs.recommended,

  // Stricter rules for source files (type-checked)
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dirname(fileURLToPath(import.meta.url)),
      },
    },
    rules: {
      // Variable hygiene
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",

      // Promise safety (critical for CLI)
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "off",

      // TypeScript best practices
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",

      // General code quality. `null: "ignore"` keeps the idiomatic `x != null`
      // nullish guard (matches both null and undefined) while still flagging
      // every other loose `==`/`!=`.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // The slash dispatch must compare through `is()` / `startsWithCmd()` (#393).
  //
  // Those helpers take a `DispatchedCommand`, so an unlisted command fails
  // `tsc` — but ONLY if the author calls them. A bare `text === '/foo'`
  // type-checks perfectly well, which would leave the guarantee resting on
  // convention while three comments claim the compiler enforces it. This rule
  // is what makes that claim true: it bans the raw comparison outright, so the
  // helper is the only way to write the branch.
  //
  // Scoped to the one file with a slash-command chain. Elsewhere `text === '…'`
  // is ordinary code.
  {
    files: ["src/ui/App.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator='==='] > Literal.right[value=/^\\//]",
          message:
            "Compare slash commands with is(text, '/cmd') so the literal is checked against DISPATCHED_COMMANDS (#393).",
        },
        {
          // Attribute match on the CallExpression, not a child selector:
          // `> Literal.arguments.0` is not valid esquery and silently matches
          // nothing — a dead rule that reads as a live one, which is the exact
          // failure this whole change is about. Verified to fire.
          //
          // `^\/.` requires a character after the slash, so the dynamic-routine
          // fallback `text.startsWith('/')` — which names no command — is left
          // alone.
          selector:
            "CallExpression[callee.property.name='startsWith'][arguments.0.value=/^\\/./]",
          message:
            "Use startsWithCmd(text, '/cmd') so the literal is checked against DISPATCHED_COMMANDS (#393).",
        },
      ],
    },
  },

  // Relaxed rules for test files (both .ts and .tsx)
  {
    files: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Disable rules that conflict with Prettier (must be last)
  eslintConfigPrettier,
);
