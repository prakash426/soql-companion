import js from '@eslint/js';

export default [
  js.configs.recommended,
  { ignores: ['dist/', 'node_modules/'] },
  {
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
];
