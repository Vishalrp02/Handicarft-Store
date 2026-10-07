import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import base from './index.js'

/** Flat config for React apps (storefront, console) and packages/ui. */
export default tseslint.config(...base, {
  files: ['**/*.{ts,tsx}'],
  languageOptions: { globals: { ...globals.browser } },
  plugins: {
    'react-hooks': reactHooks,
    'react-refresh': reactRefresh,
    'jsx-a11y': jsxA11y,
  },
  rules: {
    ...reactHooks.configs.recommended.rules,
    ...jsxA11y.flatConfigs.recommended.rules,
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
  },
})
