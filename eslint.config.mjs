import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import robloxTs from "eslint-plugin-roblox-ts";
import tseslint from "typescript-eslint";

export default defineConfig(
	{ ignores: ["out", "include"] },
	{
		files: ["src/**/*.ts", "src/**/*.tsx"],
		extends: [js.configs.recommended, tseslint.configs.recommended, robloxTs.configs.recommended],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/explicit-member-accessibility": ["error", { overrides: { constructors: "off" } }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
	prettier,
);
