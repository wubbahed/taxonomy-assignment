// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Don't lint build artifacts or vendored code.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/drizzle/**",
      "assignment/fixtures/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Tests frequently want to assert on error envelope details with
      // narrowed casts; allow `as` without fighting the rule.
      "@typescript-eslint/consistent-type-assertions": "off",

      // We use `_foo` for intentionally-unused params in stub/placeholder
      // signatures and a handful of catch parameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Tests and scripts cast to `never` / assertion helpers; overly strict.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Looser rules in test files — we want readable test data, not perfect types.
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
