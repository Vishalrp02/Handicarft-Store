import craftoria from '@craftoria/eslint-config'
import globals from 'globals'

// contracts is imported by browsers too: browser globals, no Node built-ins.
export default [
  ...craftoria,
  { languageOptions: { globals: { ...globals.browser } } },
  {
    ignores: ['src/fixtures.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'contracts must stay browser-safe' }] },
      ],
    },
  },
]
