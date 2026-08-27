import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
	{
		ignores: ['dist', 'node_modules', 'prisma/migrations'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.es2022,
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
				},
			],
		},
	},
	{
		files: ['**/*.e2e-spec.ts'],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.jest,
			},
		},
	},
	prettierPlugin,
);
