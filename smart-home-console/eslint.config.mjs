import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.gradle/**",
      "**/node_modules/**",
      "android/app/src/main/assets/panel-ui/**",
      "output/**",
      ".playwright-cli/**",
      "playwright-report/**",
      "test-results/**",
      "tmp/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/essential"],
  {
    files: ["**/*.{ts,vue}"],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] } },
    rules: {
      "no-undef": "off",
      "vue/multi-word-component-names": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["**/*.{cjs,mjs}"],
    languageOptions: {
      globals: {
        require: "readonly",
        __dirname: "readonly",
        process: "readonly",
        console: "readonly"
      }
    }
  }
];
