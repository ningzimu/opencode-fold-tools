#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, modify, applyEdits, printParseErrorCode } from 'jsonc-parser'

export const pluginPath = fileURLToPath(new URL('../index.js', import.meta.url))

export function configPath(explicit, env = process.env) {
  if (explicit || env.OPENCODE_TUI_CONFIG) return path.resolve(explicit || env.OPENCODE_TUI_CONFIG)
  const directory = env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode')
  const json = path.join(directory, 'tui.json'), jsonc = path.join(directory, 'tui.jsonc')
  if (fs.existsSync(json) && fs.existsSync(jsonc)) throw new Error('Both tui.json and tui.jsonc exist. Select one with --config <path>.')
  return fs.existsSync(jsonc) ? jsonc : json
}

function isThisPlugin(entry, config, target) {
  const spec = Array.isArray(entry) ? entry[0] : entry
  if (typeof spec !== 'string') return false
  if (/^opencode-fold-tools(?:@[^/]+)?$/.test(spec)) return true
  if (!spec.startsWith('file:') && !spec.startsWith('.') && !path.isAbsolute(spec)) return false
  try {
    const location = spec.startsWith('file:') ? fileURLToPath(spec) : path.resolve(path.dirname(config), spec)
    return path.resolve(location) === path.resolve(target)
  } catch { return false }
}

export function configure(config, action, target = pluginPath) {
  if (!['install', 'uninstall'].includes(action)) throw new Error('Action must be install or uninstall.')
  config = path.resolve(config)
  const exists = fs.existsSync(config)
  if (exists) config = fs.realpathSync(config)
  if (!exists && action === 'uninstall') return { changed: false, config }
  const original = exists ? fs.readFileSync(config, 'utf8') : '{}\n'
  const errors = []
  const data = parse(original, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) throw new Error(`Invalid config: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}. No changes made.`)
  if (typeof data !== 'object' || Array.isArray(data) || data === null) throw new Error('Config must be an object. No changes made.')
  if (data.plugin !== undefined && !Array.isArray(data.plugin)) throw new Error('The plugin field must be an array. No changes made.')
  if (action === 'install' && !fs.existsSync(target)) throw new Error(`Plugin file does not exist: ${target}`)
  const spec = pathToFileURL(target).href
  const previous = data.plugin ?? []
  const alreadyInstalled = previous.some(entry => isThisPlugin(entry, config, target))
  const next = action === 'uninstall' ? previous.filter(entry => !isThisPlugin(entry, config, target)) : alreadyInstalled ? previous : [...previous, spec]
  if (JSON.stringify(previous) === JSON.stringify(next)) return { changed: false, config, spec }
  const updated = applyEdits(original, modify(original, ['plugin'], next, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } }))
  fs.mkdirSync(path.dirname(config), { recursive: true })
  let backup
  if (exists) {
    backup = `${config}.fold-tools-backup-${Date.now()}`
    fs.copyFileSync(config, backup, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(backup, 0o600)
  }
  const temporary = `${config}.fold-tools-${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, updated, { flag: 'wx', mode: exists ? fs.statSync(config).mode & 0o777 : 0o600 })
    fs.renameSync(temporary, config)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
  return { changed: true, config, spec, backup }
}

function main(args) {
  if (args.includes('--help') || args.length === 0) {
    console.log('Usage: node scripts/configure.mjs <install|uninstall> [--config /path/to/tui.jsonc]')
    return
  }
  const action = args.shift()
  let explicit
  while (args.length) {
    const flag = args.shift()
    if (flag !== '--config' || !args[0]) throw new Error(`Unknown or incomplete option: ${flag}`)
    explicit = args.shift()
  }
  const result = configure(configPath(explicit), action)
  console.log(`${result.changed ? 'Updated' : 'Unchanged'}: ${result.config}`)
  if (result.backup) console.log(`Backup: ${result.backup}`)
  console.log(action === 'install' ? 'Plugin registered. Keep this checkout and restart OpenCode.' : 'Plugin entry removed. Restart OpenCode; other plugins and settings are unchanged.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
