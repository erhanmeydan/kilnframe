import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-probe/**",
      "**/dist-resolve/**",
      "**/dist-filmcraft/**",
      "**/node_modules/**",
      "**/vendor/**",
      "out/**",
      "examples/**",
      "styles/**",
      ".superpowers/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // UXP loads host modules (premierepro, uxp, fs, os) only through CommonJS require.
    files: ["packages/panel/**/*.ts"],
    languageOptions: { globals: globals.browser },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // kilnframe.com and the panel demo's stand-ins run in a browser
    files: ["site/**/*.js", "packages/panel/demo/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    // scene recipe kits: pasted into a scene page, which fills WIDTH and HEIGHT and calls what they define
    files: ["recipes/**/*.js", "packages/core/test/fixtures/recipes/**/*.js"],
    languageOptions: { globals: { ...globals.browser, WIDTH: "readonly", HEIGHT: "readonly" } },
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  {
    // CommonJS scripts that drive a browser (puppeteer evaluates some of their code in the page)
    files: ["scripts/**/*.cjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
