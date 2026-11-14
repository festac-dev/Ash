import tsParser from "@typescript-eslint/parser";
export default [
  { ignores: ["node_modules/**", "dist/**", "docs/**", ".ash-*/**"] },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } },
    rules: {
      "no-debugger": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-dupe-args": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["frontend/**/*.{js,jsx}", "web/*.js", "scripts/*.mjs"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } }, ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-else-if": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      eqeqeq: ["error", "always"],
    },
  },
];
