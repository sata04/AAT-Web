import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// The patch adapts upstream PR #2036's fixed-defaults clone to both published
// entrypoints. Keep this behavioral check until an official release replaces it.
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url))
const pwaRequire = createRequire(webRequire.resolve('vite-plugin-pwa'))
const workboxRequire = createRequire(pwaRequire.resolve('workbox-build'))
const cjsPath = workboxRequire.resolve('@rollup/plugin-node-resolve')
const esmPath = resolve(dirname(cjsPath), '../es/index.js')
const { rollup } = workboxRequire('rollup')

const expectedDefaults = {
  dedupe: [],
  extensions: ['.mjs', '.js', '.json', '.node'],
  resolveOnly: [],
  moduleDirectories: ['node_modules'],
  modulePaths: [],
  ignoreSideEffectsForRoot: false,
  allowExportsFolderMapping: true,
}

for (const [format, load] of [
  ['CJS', () => workboxRequire('@rollup/plugin-node-resolve')],
  ['ESM', () => import(pathToFileURL(esmPath).href)],
]) {
  test(`${format}: exported defaults preserve values and recursively frozen arrays`, async () => {
    const { DEFAULTS, nodeResolve } = await load()
    assert.deepEqual(DEFAULTS, expectedDefaults)
    assert.ok(Object.isFrozen(DEFAULTS))
    for (const [key, value] of Object.entries(expectedDefaults)) {
      if (!Array.isArray(value)) continue
      assert.notEqual(DEFAULTS[key], value)
      assert.ok(Object.isFrozen(DEFAULTS[key]))
      assert.throws(() => DEFAULTS[key].push('unexpected'), TypeError)
    }
    assert.equal(nodeResolve().name, 'node-resolve')
    assert.equal(nodeResolve({ extensions: ['.custom'] }).name, 'node-resolve')
    assert.deepEqual(DEFAULTS, expectedDefaults)
  })

  test(`${format}: real Rollup resolution preserves import and browser export conditions`, async () => {
    const { nodeResolve } = await load()
    const directory = await mkdtemp(join(tmpdir(), 'aat-node-resolve-fixture-'))
    const packageDir = join(directory, 'node_modules/fixture-package')
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(directory, 'entry.js'), "export { default } from 'fixture-package'\n")
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-package',
        type: 'module',
        exports: { browser: './browser.js', import: './import.js', default: './default.js' },
      }),
    )
    for (const name of ['browser', 'import', 'default']) {
      await writeFile(join(packageDir, `${name}.js`), `export default ${JSON.stringify(name)}\n`)
    }
    try {
      for (const [options, expected] of [
        [{}, 'import'],
        [{ browser: true }, 'browser'],
      ]) {
        const bundle = await rollup({ input: join(directory, 'entry.js'), plugins: [nodeResolve(options)] })
        try {
          const { output } = await bundle.generate({ format: 'es' })
          const loaded = await import(`data:text/javascript,${encodeURIComponent(output[0].code)}`)
          assert.equal(loaded.default, expected)
        } finally {
          await bundle.close()
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('CJS and ESM defaults are independent frozen snapshots', async () => {
  const cjs = workboxRequire('@rollup/plugin-node-resolve')
  const esm = await import(pathToFileURL(esmPath).href)
  assert.deepEqual(cjs.DEFAULTS, esm.DEFAULTS)
  assert.notEqual(cjs.DEFAULTS, esm.DEFAULTS)
  for (const key of ['dedupe', 'extensions', 'resolveOnly', 'moduleDirectories', 'modulePaths']) {
    assert.notEqual(cjs.DEFAULTS[key], esm.DEFAULTS[key])
  }
})
