import path from 'node:path'
import os from 'node:os'

const children = node => node?.getChildren?.() ?? []
const plain = node => typeof node?.plainText === 'string' ? node.plainText : ''
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
const json = value => JSON.stringify(value ?? {}, null, 2)
const running = part => ['pending', 'running'].includes(part.state.status)
const scalar = (input, omit = []) => {
  const values = Object.entries(input).filter(([key, value]) => !omit.includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
  return values.length ? `[${values.map(([key, value]) => `${key}=${value}`).join(', ')}]` : ''
}
function fileLabel(value, directory) {
  if (typeof value !== 'string') return ''
  const absolute = path.resolve(directory, value)
  const relative = path.relative(directory, absolute)
  if (!relative) return '.'
  if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return relative
  const home = os.homedir()
  return absolute.startsWith(home + path.sep) ? '~' + path.sep + absolute.slice(home.length + 1) : absolute
}

export function details(part, includeInput = false) {
  const s = part.state
  let output = s.status === 'error' ? s.error : s.output ?? s.metadata?.output
  if (s.time?.compacted) output = '[历史输出已被 OpenCode 压缩，无法恢复原文]'
  else if (output === undefined) output = running(part) ? '[正在运行，尚无输出]' : '[无文本输出]'
  const input = part.tool === 'bash' ? `$ ${s.input?.command ?? ''}` : `输入\n${json(s.input)}`
  return clean(`${includeInput ? input + '\n\n' : ''}${s.status === 'error' ? '错误\n' : ''}${typeof output === 'string' ? output : json(output)}`)
}

export function summary(part, directory) {
  const input = part.state.input ?? {}
  const file = fileLabel(input.filePath, directory)
  switch (part.tool) {
    case 'bash': return `Shell ${input.command ?? ''}`
    case 'read': return `Read ${file}`
    case 'glob': return `Glob ${input.pattern ?? ''}`
    case 'grep': return `Grep ${input.pattern ?? ''}`
    case 'edit': return `Edit ${file}`
    case 'write': return `Write ${file}`
    case 'task': return `Task ${input.description ?? ''}`
    case 'webfetch': return `WebFetch ${input.url ?? ''}`
    case 'websearch': return `WebSearch ${input.query ?? ''}`
    case 'skill': return `Skill ${input.name ?? ''}`
    case 'apply_patch': return `Patch ${(part.state.metadata?.files ?? []).map(file => file.relativePath).join(', ')}`
    case 'todowrite': return `Todos ${input.todos?.length ?? 0} 项`
    case 'question': return `Questions ${input.questions?.length ?? 0} 项`
    default: return `${part.tool} ${Object.values(input).find(v => typeof v === 'string') ?? ''}`
  }
}

export function groups(messages, getParts) {
  return messages.filter(message => message.role === 'assistant').flatMap(message =>
    getParts(message.id).filter(part => part.type === 'tool').map(part => ({
      id: part.id, parentID: message.parentID, parts: [part],
    })))
}

export function groupTitle(group, directory) {
  return summary(group.parts[0], directory)
}

// Reproduce the host's labels, including scalar arguments, to distinguish
// repeated reads at different offsets and searches in different directories.
export function matches(label, part, directory) {
  label = label.trim()
  const s = part.state.input ?? {}
  const file = fileLabel(s.filePath, directory)
  const pending = { read: 'Reading file...', glob: 'Finding files...', grep: 'Searching content...', bash: 'Writing command...', edit: 'Preparing edit...', write: 'Preparing write...', apply_patch: 'Preparing patch...', task: 'Delegating...', question: 'Asking questions...', todowrite: 'Updating todos...', skill: 'Loading skill...', webfetch: 'Fetching from the web...', websearch: 'Searching web...', execute: 'execute' }
  if (running(part) && label === `~ ${pending[part.tool] ?? 'Writing command...'}`) return true
  switch (part.tool) {
    case 'read': return label === `Read ${file} ${scalar(s, ['filePath'])}`.trim()
    case 'glob':
    case 'grep': {
      const name = part.tool === 'glob' ? 'Glob' : 'Grep'
      const prefix = `${name} "${s.pattern}"${s.path ? ` in ${fileLabel(s.path, directory)}` : ''}`
      return label === prefix || label.startsWith(prefix + ' (')
    }
    case 'bash': return label === `$ ${s.command}`.trim() || label === s.command?.trim()
    case 'edit': return label === `← Edit ${file}` || label === `Edit ${file}`
    case 'write': return label === `# Wrote ${file}` || label === `Write ${file}`
    case 'webfetch': return label === `WebFetch ${s.url}`
    case 'websearch': return typeof s.query === 'string' && /^[^\n]+ "/.test(label) && (label.endsWith(`"${s.query}"`) || label.includes(`"${s.query}" (`))
    case 'task': return typeof s.description === 'string' && /Task(?: \(background\))? — /.test(label) && label.split('\n')[0].endsWith(`— ${s.description}`)
    case 'todowrite': return label === '# Todos' || label === 'Updating todos...'
    case 'question': return label === '# Questions' || label === `Asked ${s.questions?.length} question${s.questions?.length === 1 ? '' : 's'}`
    case 'execute': return label === 'execute' || label.startsWith('execute\n')
    case 'apply_patch': return (part.state.status === 'error' && label === 'Patch failed') || (part.state.metadata?.files ?? []).some(file => {
      const expected = file.type === 'delete' ? `# Deleted ${file.relativePath}` : file.type === 'add' ? `# Created ${file.relativePath}` : file.type === 'move' ? `# Moved ${fileLabel(file.filePath, directory)} → ${file.relativePath}` : `← Patched ${file.relativePath}`
      return label === expected
    })
    case 'skill': return label === `Skill "${s.name}"`
    default: return label === `${part.tool} ${scalar(s)}`.trim() || label === `# ${part.tool} ${scalar(s)}`.trim()
  }
}

export default {
  id: 'opencode-fold-tools',
  async tui(api) {
    let sessionID, allOpen = false, serial = 0
    const opened = new Set(), widgets = new Map(), hidden = new Map(), owned = new WeakSet(), nativeHeaders = new Map(), separate = new WeakSet()
    let disposed = false
    // The host must create tool rows before this plugin can replace them.
    if (api.kv?.get('tool_details_visibility', true) === false) api.kv.set('tool_details_visibility', true)
    const model = () => groups(api.state.session.messages(api.route.current.params?.sessionID), id => api.state.part(id))
    const text = (Sample, content, options = {}) => {
      const node = new Sample(api.renderer, { id: `fold-tools-${++serial}`, content, fg: api.theme.current.text, wrapMode: 'word', flexShrink: 0, ...options })
      owned.add(node); return node
    }
    function remove(widget) {
      if (!widget.root.isDestroyed) {
        if (widget.root.destroyRecursively) widget.root.destroyRecursively(); else widget.root.destroy()
      }
    }
    function reset() {
      for (const widget of widgets.values()) remove(widget)
      widgets.clear()
      for (const [node, visible] of hidden) if (!node.isDestroyed) node.visible = visible
      hidden.clear(); opened.clear()
      for (const [node, visible] of nativeHeaders) if (!node.isDestroyed) node.visible = visible
      nativeHeaders.clear()
    }
    function findTranscript(node) {
      if (!node || node.isDestroyed || owned.has(node)) return
      if (node.stickyScroll && node.stickyStart === 'bottom') return node
      if (typeof node.scrollTo === 'function') return
      for (const child of children(node)) { const found = findTranscript(child); if (found) return found }
    }
    function candidates(transcript, userIDs) {
      const found = []
      let parentID
      function visit(node) {
        if (!node || node.isDestroyed || owned.has(node)) return
        if (userIDs.has(node.id)) parentID = node.id
        const kids = children(node)
        for (const row of kids) {
          const peers = children(row)
          if (peers.length === 2 && /^[→←✱⚙$%◈✓│✗]$/.test(plain(peers[0]).trim()) && plain(peers[1])) {
            found.push({ node: peers[1], host: node, label: plain(peers[1]).trim(), parentID })
            return
          }
        }
        const head = kids.find(child => plain(child).trim())
        if (head && plain(head).startsWith('~ ')) {
          found.push({ node: head, host: node, label: plain(head).trim(), parentID })
          return
        }
        if (head && !plain(head).startsWith('# Running in ') && /^(# |← (Edit|Patched) )/.test(plain(head))) {
          found.push({ node: head, host: node, label: plain(head).trim(), parentID, native: /^(← (Edit|Patched) |# (Wrote|Created|Deleted|Moved) )/.test(plain(head)) })
          return
        }
        for (const inner of kids) {
          const command = children(inner)[0]
          if (plain(command).startsWith('$ ')) {
            found.push({ node: command, host: node, label: plain(command).trim(), parentID })
            return
          }
        }
        for (const child of children(node)) visit(child)
      }
      visit(transcript)
      return found
    }
    function sweep() {
      if (disposed) return
      if (api.route.current.name !== 'session') { reset(); sessionID = undefined; return }
      const id = api.route.current.params?.sessionID
      if (id !== sessionID) { reset(); sessionID = id }
      const transcript = findTranscript(api.renderer.root)
      if (!transcript) return
      const list = model(), records = list.flatMap(group => group.parts.map(part => ({ group, part })))
      const userIDs = new Set(api.state.session.messages(id).filter(m => m.role === 'user').map(m => m.id))
      const roots = new Map(), matched = new Set(), usedHosts = new Set(), patchFiles = new Map()
      let cursor = 0
      for (const candidate of candidates(transcript, userIDs)) {
        if (usedHosts.has(candidate.host)) continue
        const index = records.findIndex((r, i) => i >= cursor && (!candidate.parentID || r.group.parentID === candidate.parentID) && matches(candidate.label, r.part, api.state.path.directory))
        if (index < 0) continue
        const record = records[index]
        cursor = index
        if (record.part.tool === 'apply_patch') {
          const seen = patchFiles.get(record.part.id) ?? new Set()
          seen.add(candidate.label); patchFiles.set(record.part.id, seen)
          if (seen.size >= (record.part.state.metadata?.files?.length ?? 1)) cursor++
        } else cursor++
        usedHosts.add(candidate.host); matched.add(candidate.host)
        if (!roots.has(record.group.id)) roots.set(record.group.id, [])
        roots.get(record.group.id).push(candidate)
      }
      for (const [host, visible] of hidden) if (host.isDestroyed || !matched.has(host)) { if (!host.isDestroyed) host.visible = visible; hidden.delete(host) }
      for (const host of matched) { if (!hidden.has(host)) hidden.set(host, host.visible); host.visible = false }
      for (const [key, widget] of widgets) if (!roots.has(key) || widget.root.isDestroyed) { remove(widget); widgets.delete(key) }
      for (const group of list) {
        const anchors = roots.get(group.id)
        if (!anchors?.length) continue
        const anchor = anchors[0]
        let widget = widgets.get(group.id)
        if (!widget) {
          const root = new anchor.host.constructor(api.renderer, { id: `fold-tools-${++serial}`, flexDirection: 'column', paddingLeft: 3, flexShrink: 0 })
          owned.add(root)
          if (group.parts[0].tool === 'task') separate.add(root)
          // Match native inline spacing, skipping the original tool hosts we hide.
          root.onLifecyclePass = () => {
            const siblings = children(root.parent)
            const previous = siblings.slice(0, siblings.indexOf(root)).findLast(node => node.visible !== false && !node.isDestroyed)
            const margin = separate.has(root) || previous && (previous.height > 1 || separate.has(previous)) ? 1 : 0
            if (root.marginTop !== margin) root.marginTop = margin
          }
          const header = text(anchor.node.constructor, '', { maxHeight: 1, overflow: 'hidden', selectable: false })
          const body = new transcript.constructor(api.renderer, { id: `fold-tools-${++serial}`, height: 14, width: '100%', border: ['left'], borderColor: api.theme.current.borderSubtle, backgroundColor: api.theme.current.backgroundPanel, padding: 1, stickyScroll: false, flexShrink: 0 })
          owned.add(body)
          const content = text(anchor.node.constructor, '', { selectable: true })
          body.add(content); root.add(header); root.add(body)
          const navigation = text(anchor.node.constructor, '打开子任务 →', { selectable: false, fg: api.theme.current.primary })
          root.add(navigation)
          widget = { root, header, body, content, navigation, group }
          widgets.set(group.id, widget)
          if (allOpen) opened.add(group.id)
          header.onMouseUp = event => {
            if (api.renderer.getSelection?.()?.getSelectedText?.()) return
            if (opened.has(group.id)) opened.delete(group.id); else opened.add(group.id)
            refresh(widget); event?.stopPropagation?.()
          }
          navigation.onMouseUp = event => {
            const childID = widget.group.parts[0].state.metadata?.sessionId
            if (childID) api.route.navigate('session', { sessionID: childID })
            event?.stopPropagation?.()
          }
        }
        widget.group = group
        widget.native = ['edit', 'write', 'apply_patch'].includes(group.parts[0].tool) && anchors.every(a => a.native)
        widget.anchors = anchors
        if (widget.native) for (const item of anchors) {
          if (!nativeHeaders.has(item.node)) nativeHeaders.set(item.node, item.node.visible)
        }
        if (widget.root.parent !== anchor.host.parent || children(anchor.host.parent).indexOf(widget.root) + 1 !== children(anchor.host.parent).indexOf(anchor.host)) anchor.host.parent.insertBefore(widget.root, anchor.host)
        refresh(widget)
      }
    }
    function refresh(widget) {
      const { group } = widget, open = opened.has(group.id)
      const title = `${open ? '▾' : '▸'} ${groupTitle(group, api.state.path.directory).replace(/\s+/g, ' ')}`
      if (widget.header.content !== title) widget.header.content = title
      widget.root.visible = true
      if (widget.native) for (const anchor of widget.anchors) {
        anchor.host.visible = open
        anchor.node.visible = open ? false : nativeHeaders.get(anchor.node)
      }
      widget.root.backgroundColor = api.theme.current.background
      widget.body.visible = open && !widget.native
      widget.navigation.visible = open && group.parts[0].tool === 'task' && Boolean(group.parts[0].state.metadata?.sessionId)
      if (open) {
        const value = details(group.parts[0])
        if (widget.content.content !== value) widget.content.content = value
        widget.body.height = Math.min(16, Math.max(5, value.split('\n').length + 2))
      }
    }
    function picker() {
      const parts = model().flatMap(group => group.parts)
      api.ui.dialog.replace(() => api.ui.DialogSelect({ title: '所有工具详情', options: parts.map((part, index) => ({
        title: `${index + 1}. ${summary(part, api.state.path.directory).replace(/\s+/g, ' ')}`,
        description: part.state.status, value: part.id,
        onSelect: () => api.ui.dialog.replace(() => api.ui.DialogAlert({ title: part.tool, message: details(part, true) })),
      })) }))
    }
    const unregister = api.keymap.registerLayer({ mode: 'base', priority: 110,
      commands: [{ name: 'fold_tools.toggle', title: '展开 / 折叠所有工具', category: 'Plugin', run() {
        allOpen = !allOpen; sweep()
        for (const key of widgets.keys()) { if (allOpen) opened.add(key); else opened.delete(key) }
        for (const widget of widgets.values()) refresh(widget)
        api.ui.toast({ variant: 'info', message: `${allOpen ? '已展开' : '已折叠'} ${widgets.size} 个工具`, duration: 1500 })
        return true
      } }, { name: 'fold_tools.list', title: '所有工具详情', category: 'Plugin', run() { picker(); return true } }],
      bindings: [{ key: 'ctrl+o', cmd: 'fold_tools.toggle', desc: '展开 / 折叠所有工具', preventDefault: true }],
    })
    const off = [api.event.on('message.part.updated', sweep), api.event.on('message.updated', sweep)]
    const timer = setInterval(sweep, 1000)
    api.lifecycle.onDispose(() => { disposed = true; clearInterval(timer); off.forEach(fn => fn()); if (typeof unregister === 'function') unregister(); reset() })
  },
}
