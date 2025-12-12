

import path from "node:path";
import globals from "globals";
import eslintJS from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPrettierConfig from "eslint-config-prettier/flat";
import { includeIgnoreFile } from "@eslint/compat";

export default tseslint.config(

    {
        files: ["**/*.{ts,tsx,js,cjs}"],
    },


    {
        ignores: [
            "**/*.mjs",
            "eslint.config.mjs",
            ".solcover.js",
            ".github/**/*",
            "artifacts/**/*",
            "cache/**/*",
            "typechain-types/**/*",
            "ignition/deployments/**/*",
        ],
    },


    eslintJS.configs.recommended,


    ...tseslint.configs.recommendedTypeChecked,

    ...tseslint.configs.stylisticTypeChecked,


    {
        rules: {

            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

            "no-undef": "off",


            quotes: ["error", "double", { avoidEscape: true }],
            "eol-last": ["error", "always"],
            "max-len": ["warn", { code: 120, ignoreUrls: true }],
            "no-trailing-spaces": ["error"],


            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "@typescript-eslint/unified-signatures": "off",
        },
    },


    {
        files: ["test/**/*.ts", "tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unused-expressions": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "@typescript-eslint/no-non-null-assertion": "off",

            "no-restricted-properties": [
                "warn",
                {
                    object: "describe",
                    property: "only",
                    message: "Please, remember to remove `.only` before committing.",
                },
                {
                    object: "context",
                    property: "only",
                    message: "Please, remember to remove `.only` before committing.",
                },
                {
                    object: "it",
                    property: "only",
                    message: "Please, remember to remove `.only` before committing.",
                },
            ],
        },
    },


    {
        files: ["scripts/**/*.ts", "deploy/**/*.ts", "scripts/**/*.js", "deploy/**/*.js"],
        rules: {
            "no-console": "off",

            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },


    eslintPrettierConfig,


    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: path.resolve(import.meta.dirname),
            },
            globals: {
                ...globals.es2020,
                ...globals.node,

                ...globals.mocha,
                ...globals.chai,
                artifacts: "readonly",
                contract: "readonly",
                network: "readonly",
                ethers: "readonly",
            },
        },
    },


    includeIgnoreFile(path.resolve(import.meta.dirname, ".gitignore"))
);