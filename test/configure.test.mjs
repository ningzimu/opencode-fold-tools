import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'jsonc-parser'
import { configure, configPath } from '../scripts/configure.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold tools-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'plugin file.mjs')
  fs.writeFileSync(target, 'export default {}')
  return { dir, target, config: path.join(dir, 'tui.jsonc') }
}

test('install preserves JSONC settings, backs up, is idempotent and uninstalls only itself', t => {
  const { config, target } = fixture(t)
  const original = '{\n  // keep theme\n  "theme": "nord",\n  "plugin": ["other-plugin",],\n}\n'
  fs.writeFileSync(config, original)
  const result = configure(config, 'install', target)
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original)
  const installed = fs.readFileSync(config, 'utf8')
  assert.ok(installed.includes('// keep theme'))
  assert.deepEqual(parse(installed), { theme: 'nord', plugin: ['other-plugin', pathToFileURL(target).href] })
  assert.equal(configure(config, 'install', target).changed, false)
  assert.equal(fs.readFileSync(config, 'utf8'), installed)
  configure(config, 'uninstall', target)
  assert.deepEqual(parse(fs.readFileSync(config, 'utf8')), { theme: 'nord', plugin: ['other-plugin'] })
  assert.equal(configure(config, 'uninstall', target).changed, false)
})

test('invalid configs are unchanged', t => {
  const { config, target } = fixture(t)
  for (const original of ['null', '[]', '{broken', '{"plugin": "bad"}']) {
    fs.writeFileSync(config, original)
    assert.throws(() => configure(config, 'install', target))
    assert.equal(fs.readFileSync(config, 'utf8'), original)
  }
})

test('new config and npm entry uninstall', t => {
  const { config, target } = fixture(t)
  assert.equal(configure(config, 'uninstall', target).changed, false)
  configure(config, 'install', target)
  assert.deepEqual(parse(fs.readFileSync(config, 'utf8')).plugin, [pathToFileURL(target).href])
  fs.writeFileSync(config, JSON.stringify({ plugin: [['opencode-fold-tools@0.1.0', {}], 'unrelated'] }))
  configure(config, 'uninstall', target)
  assert.deepEqual(parse(fs.readFileSync(config, 'utf8')).plugin, ['unrelated'])
})

test('config discovery respects explicit and environment paths and rejects ambiguity', t => {
  const { dir, config } = fixture(t)
  assert.equal(configPath(config, {}), config)
  assert.equal(configPath(undefined, { OPENCODE_TUI_CONFIG: config }), config)
  assert.equal(configPath(undefined, { OPENCODE_CONFIG_DIR: dir }), path.join(dir, 'tui.json'))
  fs.writeFileSync(config, '{}')
  assert.equal(configPath(undefined, { OPENCODE_CONFIG_DIR: dir }), config)
  fs.writeFileSync(path.join(dir, 'tui.json'), '{}')
  assert.throws(() => configPath(undefined, { OPENCODE_CONFIG_DIR: dir }))
})
