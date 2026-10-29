import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('npm Pyodide has a final visual-review exclusion after broad automerge rules', () => {
  const source = readFileSync(new URL('../renovate.json5', import.meta.url), 'utf8')
  // These are the top-level packageRules blocks in the checked-in, consistently indented JSON5.
  const rules = [...source.matchAll(/^ {4}\{[\s\S]*?^ {4}\},?/gm)].map((match) => match[0])
  const index = rules.findIndex((rule) => /matchPackageNames:\s*\["pyodide"\]/.test(rule))
  assert.notEqual(index, -1)
  const pyodide = rules[index]
  assert.match(pyodide, /matchDatasources:\s*\["npm"\]/)
  assert.match(pyodide, /automerge:\s*false/)
  assert.doesNotMatch(pyodide, /matchUpdateTypes:/) // all updates, including minor/patch
  assert.match(pyodide, /"visual-contract"/)
  assert.match(pyodide, /"needs-visual-review"/)
  for (const [position, rule] of rules.entries()) {
    if (/automerge:\s*true/.test(rule)) assert.ok(position < index)
  }
  assert.ok(
    rules.some(
      (rule) => /matchUpdateTypes:\s*\["minor", "patch"\]/.test(rule) && /automerge:\s*true/.test(rule),
    ),
  )
})
