import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

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

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  }
  const mod = loaded.factory((name) => (name === 'react' ? React : undefined))
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
  return registered
}

function loadCard() {
  const registered = loadModule()
  assert.equal(typeof registered.get('research'), 'function')
  return registered.get('research')
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