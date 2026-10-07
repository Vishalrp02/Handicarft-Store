import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const eslint = new ESLint({ cwd: fixtures, overrideConfigFile: join(here, '..', 'index.js') })

const ruleIds = async (file) => {
  const [result] = await eslint.lintFiles([join(fixtures, file)])
  return result.messages.map((m) => m.ruleId ?? m.message)
}

test('clean TypeScript passes the base config', async () => {
  assert.deepEqual(await ruleIds('good.ts'), [])
})

test('console, any and non-null assertion are errors', async () => {
  const ids = await ruleIds('bad.ts')
  assert.ok(ids.includes('no-console'), ids.join(','))
  assert.ok(ids.includes('@typescript-eslint/no-explicit-any'), ids.join(','))
  assert.ok(ids.includes('@typescript-eslint/no-non-null-assertion'), ids.join(','))
})

test('react config loads', async () => {
  const react = (await import('../react.js')).default
  assert.ok(Array.isArray(react) && react.length > 0)
})
