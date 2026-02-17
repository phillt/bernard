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
        tsconfigRootDir: import.meta.dirname,
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

      // General code quality
      eqeqeq: "error",
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // Relaxed rules for test files
  {
    files: ["src/**/*.test.ts"],
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
