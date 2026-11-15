import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/**
 * Minimal hook runtime: enough for the card's `useState`/`useRef` from a plain
 * function call (no DOM, no React). `setState` repaints the mounted component,
 * so a test can click a button and then read `Card.tree()`.
 */
function createHooks() {
  const slots = []
  const effects = []
  let cursor = 0
  let instance
  let tree

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (Object.is(value, slots[index])) return
        slots[index] = value
        if (instance) paint()
      }]
    },
    // Recorded but not executed: the stub has no lifecycle, and running the
    // composer's initial read would make these tests depend on tick order.
    useEffect(fn) { effects.push(fn) },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
  }

  function paint() {
    cursor = 0
    tree = instance.Component(instance.props)
    return tree
  }

  function mount(Component, props) {
    instance = { Component, props }
    slots.length = 0
    effects.length = 0
    return paint()
  }

  return {
    React,
    mount,
    current: () => tree,
    /** Run the effects recorded by the last paint (the stub never auto-runs them). */
    runEffects() {
      const pending = effects.splice(0)
      for (const effect of pending) effect()
    },
  }
}

function loadModule(extra = {}) {
  let loaded
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    globalThis.window = previous
  }
  assert.equal(loaded?.id, '@local/dsh-global-research')

  const hooks = createHooks()
  const mod = loaded.factory((name) => (name === 'react' ? hooks.React : undefined))
  const registered = new Map()
  mod.apply({
    ...extra,
    slots: {
      inject: (_slot, fn) => {
        const effect = fn()
        if (effect && typeof effect.next === 'function') {
          for (const item of effect) void item
        }
      },
      register: (options, component) => { registered.set(options.key ?? options.id ?? options.name, component) },
    },
  })
  registered.hooks = hooks
  return registered
}

function loadCard() {
  const registered = loadModule()
  const Component = registered.get('research')
  assert.equal(typeof Component, 'function')
  const hooks = registered.hooks
  const view = (props) => hooks.mount(Component, props)
  // A click repaints the same component; read the newest tree from here.
  view.tree = () => hooks.current()
  return view
}

function loadPanel() {
  return loadModule().get('@local/dsh-global-research#global-research')
}

const BRIEF = `## 结论
Node 22 的 EOL 是 **2027-04-30** [S1]；新项目建议 Node 24 [S2]。

## 依据
1. 发布计划表给出日期 [S1]

## 置信度

**medium**：日期来自官方表，但 Node 24 行缺失。

## 未解决
- Node 24 的具体 EOL 日期

## 参考
- [S1] github.com — https://github.com/nodejs/Release
- [S2] nodejs.org — https://nodejs.org/en/blog/v24`

const BRIEF_WITH_STATS = `${BRIEF}

> 本次检索：6 个查询 · 9 个页面 · 14 条证据 · 73 秒（标准档）`

function resultBlock(extra = {}) {
  return {
    kind: 'tool-result',
    call: {
      name: 'research',
      argsRaw: '{"question":"Node 22 还是 24"}',
      args: { question: 'Node 22 还是 24', depth: 'standard' },
    },
    content: [{ type: 'text', text: BRIEF }],
    meta: { elapsedMs: 73000 },
    isError: false,
    ...extra,
  }
}

test('research card parses confidence, source count and duration', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({ phase: 'result', block: resultBlock() }))
  assert.match(json, /中置信度/)
  assert.match(json, /2 个来源/)
  assert.match(json, /73s/)
  assert.match(json, /Node 22 的 EOL 是/)
  assert.doesNotMatch(json, /\[S1\]/)
})

test('research card renders the run-stats row parsed from the brief', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({
    phase: 'result',
    block: resultBlock({ content: [{ type: 'text', text: BRIEF_WITH_STATS }] }),
  }))
  assert.match(json, /6 查询/)
  assert.match(json, /9 页面/)
  assert.match(json, /14 条证据/)
  assert.match(json, /73 秒/)
})

test('research card omits the run-stats row for older briefs', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({ phase: 'result', block: resultBlock() }))
  assert.doesNotMatch(json, /条证据/)
  assert.doesNotMatch(json, /个页面/)
})

test('research card renders slow stages as a second row of chips', () => {
  const Card = loadCard()
  const stages = ' · 阶段 拆题1s/检索12s/精读30s/合成25s'
  const json = JSON.stringify(Card({
    phase: 'result',
    block: resultBlock({ content: [{ type: 'text', text: `${BRIEF_WITH_STATS}${stages}` }] }),
  }))
  assert.match(json, /阶段 拆题1s/)
  for (const chip of ['检索12s', '精读30s', '合成25s']) assert.match(json, new RegExp(chip))
  // A stats line without the 阶段 segment must not render the extra row.
  const plain = JSON.stringify(Card({
    phase: 'result',
    block: resultBlock({ content: [{ type: 'text', text: BRIEF_WITH_STATS }] }),
  }))
  assert.doesNotMatch(plain, /阶段 /)
})

test('research card shows a failure row for errored calls', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({
    phase: 'result',
    block: resultBlock({ isError: true, content: [{ type: 'text', text: 'boom' }] }),
  }))
  assert.match(json, /失败/)
  assert.match(json, /boom/)
})

test('research card shows the question while the call is running', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({
    phase: 'start',
    block: { phase: 'start', args: { question: '为什么 503' } },
  }))
  assert.match(json, /研究中/)
  assert.match(json, /为什么 503/)
})

test('research card falls back when the brief has no sections', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({
    phase: 'result',
    block: resultBlock({ content: [{ type: 'text', text: 'plain text only' }] }),
  }))
  assert.match(json, /plain text only|无结论段/)
})

function findClickable(node) {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findClickable(item)
      if (found) return found
    }
    return undefined
  }
  if (node.props && typeof node.props.onClick === 'function') return node
  if (typeof node.type === 'function' && node.props) {
    const rendered = node.type(node.props)
    const found = findClickable(rendered)
    if (found) return found
  }
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    const found = findClickable(child)
    if (found) return found
  }
  return undefined
}

test('research card header is clickable to toggle the full text', () => {
  const Card = loadCard()
  const tree = Card({ phase: 'result', block: resultBlock() })
  const clickable = findClickable(tree)
  assert.ok(clickable, 'expected a clickable header')
  assert.equal(clickable.props.role, 'button')
  clickable.props.onClick()
})

test('composer control falls back to a settings hint when the remote bridge is missing', () => {
  const Control = loadModule().get('global-research-depth')
  assert.equal(typeof Control, 'function')
  const tree = Control({})
  assert.match(JSON.stringify(tree), /深度：设置页/)
})

test('composer control cycles the depth through settings.mutate', async () => {
  const writes = []
  const remote = {
    settings: {
      describe: async () => ({
        ok: true,
        value: { namespaces: [{ ns: 'global-research', revision: 7, user: { depthDefault: 'auto', enabled: true } }] },
      }),
      mutate: async (ns, ops, revision) => {
        writes.push({ ns, ops, revision })
        return { ok: true }
      },
    },
  }
  const Control = loadModule({ remote }).get('global-research-depth')
  const tree = Control({})
  const depthButton = collectButtons(tree).find((node) => (node.children || []).join('').startsWith('深度'))
  assert.ok(depthButton, 'expected the depth chip')
  depthButton.props.onClick()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, 'global-research')
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['depthDefault'], value: 'quick' }])
  assert.equal(writes[0].revision, undefined)
})

test('composer control toggles the research tool through settings.mutate', async () => {
  const writes = []
  const remote = {
    settings: {
      describe: async () => ({
        ok: true,
        value: { namespaces: [{ ns: 'global-research', revision: 9, user: { depthDefault: 'standard', enabled: true } }] },
      }),
      mutate: async (ns, ops, revision) => {
        writes.push({ ns, ops, revision })
        return { ok: true }
      },
    },
  }
  const Control = loadModule({ remote }).get('global-research-depth')
  const tree = Control({})
  const toggle = collectButtons(tree).find((node) => (node.children || []).join('').startsWith('研究'))
  assert.ok(toggle, 'expected the enable toggle')
  toggle.props.onClick()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['enabled'], value: false }])
})

function collectButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  if (typeof node.type === 'function' && node.props) collectButtons(node.type(node.props), out)
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) collectButtons(child, out)
  return out
}

function buttonLabelled(tree, label) {
  return collectButtons(tree).find((node) => (node.children || []).join('') === label)
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  visit(node)
  if (typeof node.type === 'function' && node.props) {
    walk(node.type(node.props), visit)
    return
  }
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) walk(child, visit)
}

function collectLinks(tree) {
  const links = []
  walk(tree, (node) => { if (node.type === 'a') links.push(node) })
  return links
}

function nodeWithText(tree, text) {
  let found
  walk(tree, (node) => {
    if (found) return
    if ((node.children || []).join('') === text) found = node
  })
  return found
}

/** First node of a given element type (textarea, input, …). */
function nodeOfType(tree, type) {
  let found
  walk(tree, (node) => { if (!found && node.type === type) found = node })
  return found
}

/** Replace a global for one test and hand back the undo step. */
function stubGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {
    value, configurable: true, writable: true, enumerable: true,
  })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
}

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

function formStub(value = { depthDefault: 'auto', enabled: true }, revision = 7) {
  const calls = []
  return {
    calls,
    form: {
      state: { value, revision },
      mutate: async (ops, expectedRevision) => {
        calls.push({ ops, expectedRevision })
        return true
      },
    },
  }
}

test('config panel summary names the current default depth', () => {
  const Panel = loadPanel()
  const { form } = formStub({ depthDefault: 'deep', enabled: true })
  const json = JSON.stringify(Panel({ view: 'summary', form }))
  assert.match(json, /深度/)
})

test('config panel saves a new default depth through form.mutate', async () => {
  const Panel = loadPanel()
  const { calls, form } = formStub()
  const tree = Panel({ view: 'page', form })
  const button = buttonLabelled(tree, '标准')
  assert.ok(button, 'expected a 标准 depth button')
  button.props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls[0], {
    ops: [{ op: 'set', path: ['depthDefault'], value: 'standard' }],
    expectedRevision: 7,
  })
})

test('config panel points at the plugin switch instead of writing enabled', () => {
  const Panel = loadPanel()
  const { calls, form } = formStub()
  const tree = Panel({ view: 'page', form })
  const json = JSON.stringify(tree)
  assert.match(json, /启用 research 工具/)
  assert.match(json, /插件开关/)
  assert.equal(buttonLabelled(tree, '已启用'), undefined)
  assert.equal(calls.length, 0)
})

test('config panel explains when the host exposes no config form', () => {
  const Panel = loadPanel()
  const json = JSON.stringify(Panel({ view: 'page', form: undefined }))
  assert.match(json, /配置页暂不可用/)
})

/* ------------------------------------------------------------------ */
/* paste box for research material (0.9.3)                            */
/* ------------------------------------------------------------------ */

function mountPanel(value = {}, revision = 7) {
  const registered = loadModule()
  const Panel = registered.get('@local/dsh-global-research#global-research')
  const stub = formStub(value, revision)
  const view = () => registered.hooks.mount(Panel, { view: 'page', form: stub.form })
  return { ...stub, view, tree: () => registered.hooks.current(), hooks: registered.hooks }
}

test('config panel summary shows how much material is saved (0.9.3)', () => {
  const Panel = loadPanel()
  const { form } = formStub({ depthDefault: 'auto', enabled: true, material: '一段内部材料' })
  const json = JSON.stringify(Panel({ view: 'summary', form }))
  assert.match(json, /材料 \d+ 字/)
})

test('config panel saves pasted material through form.mutate (0.9.3)', async () => {
  const panel = mountPanel()
  panel.view()
  const textarea = nodeOfType(panel.tree(), 'textarea')
  assert.ok(textarea, 'expected a paste box')
  textarea.props.onChange({ target: { value: '  合同约定赔偿上限 30%  ' } })
  assert.match(JSON.stringify(panel.tree()), /草稿 \d+ 字/)
  const save = buttonLabelled(panel.tree(), '保存材料')
  assert.ok(save, 'expected the 保存材料 button')
  assert.equal(save.props.disabled, false, 'a dirty draft can be saved')
  save.props.onClick()
  await tick()
  assert.deepEqual(panel.calls[0], {
    ops: [{ op: 'set', path: ['material'], value: '合同约定赔偿上限 30%' }],
    expectedRevision: 7,
  })
})

test('config panel clears saved material through form.mutate (0.9.3)', async () => {
  const panel = mountPanel({ depthDefault: 'auto', enabled: true, material: '旧材料' })
  panel.view()
  const clear = buttonLabelled(panel.tree(), '清空')
  assert.ok(clear, 'expected the 清空 button')
  assert.equal(clear.props.disabled, false)
  clear.props.onClick()
  await tick()
  assert.deepEqual(panel.calls[0].ops, [{ op: 'set', path: ['material'], value: '' }])
})

test('composer control shows a material chip when the settings hold material (0.9.3)', async () => {
  const remote = {
    settings: {
      describe: async () => ({
        ok: true,
        value: { namespaces: [{ ns: 'global-research', revision: 3, user: { depthDefault: 'auto', enabled: true, material: '内部材料' } }] },
      }),
      mutate: async () => ({ ok: true }),
    },
  }
  const registered = loadModule({ remote })
  const Control = registered.get('global-research-depth')
  const view = () => registered.hooks.mount(Control, {})
  view()
  registered.hooks.runEffects()
  await tick()
  assert.match(JSON.stringify(registered.hooks.current()), /材料 \d+ 字/)
})

/* ------------------------------------------------------------------ */
/* card interactions: copy, sources, failure, empty, running           */
/* ------------------------------------------------------------------ */

test('research card copies the whole brief Markdown from the header', async () => {
  const written = []
  const restore = stubGlobal('navigator', {
    clipboard: {
      writeText: (value) => {
        written.push(value)
        return Promise.resolve()
      },
    },
  })
  try {
    const Card = loadCard()
    const tree = Card({ phase: 'result', block: resultBlock() })
    const button = buttonLabelled(tree, '复制')
    assert.ok(button, 'expected a 复制 button in the header')
    button.props.onClick({ stopPropagation() {} })
    await tick()
    assert.equal(written.length, 1)
    assert.match(written[0], /## 结论/)
    assert.match(written[0], /\[S1\]/)
    assert.match(JSON.stringify(Card.tree()), /已复制/)
  } finally {
    restore()
  }
})

test('research card reports 复制失败 when the clipboard rejects and no fallback exists', async () => {
  const restore = stubGlobal('navigator', {
    clipboard: { writeText: () => Promise.reject(new Error('denied')) },
  })
  try {
    const Card = loadCard()
    const tree = Card({ phase: 'result', block: resultBlock() })
    buttonLabelled(tree, '复制').props.onClick({ stopPropagation() {} })
    await tick()
    assert.match(JSON.stringify(Card.tree()), /复制失败/)
  } finally {
    restore()
  }
})

test('research card falls back to execCommand without navigator.clipboard', async () => {
  const calls = []
  const body = {
    appendChild: (el) => { el.parentNode = body },
    removeChild: (el) => { if (el.parentNode === body) el.parentNode = null },
  }
  const documentStub = {
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      select() { calls.push(this.value) },
    }),
    body,
    execCommand: (command) => {
      calls.push(command)
      return true
    },
  }
  const restoreNav = stubGlobal('navigator', {})
  const restoreDoc = stubGlobal('document', documentStub)
  try {
    const Card = loadCard()
    const tree = Card({ phase: 'result', block: resultBlock() })
    buttonLabelled(tree, '复制').props.onClick({ stopPropagation() {} })
    await tick()
    assert.deepEqual(calls, [BRIEF, 'copy'])
    assert.match(JSON.stringify(Card.tree()), /已复制/)
  } finally {
    restoreDoc()
    restoreNav()
  }
})

test('research card lists two source links from the brief', () => {
  const Card = loadCard()
  const tree = Card({ phase: 'result', block: resultBlock() })
  const collapsed = JSON.stringify(tree)
  assert.match(collapsed, /来源 2/)
  assert.doesNotMatch(collapsed, /github\.com\/nodejs\/Release/)

  const toggle = buttonLabelled(tree, '来源 2')
  assert.ok(toggle, 'expected a 来源 toggle')
  toggle.props.onClick()

  const links = collectLinks(Card.tree())
  assert.equal(links.length, 2)
  assert.equal(links[0].props.href, 'https://github.com/nodejs/Release')
  assert.equal(links[1].props.href, 'https://nodejs.org/en/blog/v24')
  for (const link of links) {
    assert.equal(link.props.target, '_blank')
    assert.equal(link.props.rel, 'noreferrer')
  }
  assert.match(JSON.stringify(links[0]), /github\.com/)
  assert.match(JSON.stringify(links[1]), /nodejs\.org/)
})

test('research card omits the sources block when the brief has no reference rows', () => {
  const Card = loadCard()
  const tree = Card({
    phase: 'result',
    block: resultBlock({ content: [{ type: 'text', text: '## 结论\n只有结论，没有参考行 [S7]' }] }),
  })
  // A bare inline [S7] still counts toward the header total, but with no
  // `- [S7] … — https://…` row there is nothing to link to.
  assert.equal(collectLinks(tree).length, 0)
  assert.equal(buttonLabelled(tree, '来源 1'), undefined)
})

test('research card shows 研究失败 in red with a 200 character preview', () => {
  const Card = loadCard()
  const long = 'x'.repeat(400)
  const tree = Card({
    phase: 'result',
    block: resultBlock({ isError: true, content: [{ type: 'text', text: long }] }),
  })
  const json = JSON.stringify(tree)
  assert.match(json, /研究失败/)
  const title = nodeWithText(tree, '研究失败')
  assert.ok(title, 'expected the failure title')
  assert.match(String(title.props.style.color), /c0504d/i)
  assert.match(json, /x{200}/)
  assert.doesNotMatch(json, /x{201}/)
})

test('research card says 没有拿到简报 when the brief is empty', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({
    phase: 'result',
    block: resultBlock({ content: [{ type: 'text', text: '   ' }] }),
  }))
  assert.match(json, /没有拿到简报/)
})

test('research card shows a spinning 研究中… while the call runs', () => {
  const Card = loadCard()
  const json = JSON.stringify(Card({
    phase: 'start',
    block: { phase: 'start', args: { question: '为什么 503' } },
  }))
  assert.match(json, /研究中/)
  assert.match(json, /gr-card-spin/)
})