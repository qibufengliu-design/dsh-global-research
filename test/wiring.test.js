import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

function fakeHarness() {
  const registered = {}
  const web = {
    async search({ query }) {
      return {
        sources: [
          { url: `https://a.com/${encodeURIComponent(query)}`, title: 'Node LTS release notes', snippet: 'Node 22 is LTS.' },
          { url: `https://b.com/${encodeURIComponent(query)}`, title: 'Node LTS official documentation', snippet: 'Node 22 active LTS.' },
          { url: `https://c.com/${encodeURIComponent(query)}`, title: 'Node LTS community discussion', snippet: 'LTS support.' },
        ],
      }
    },
    async fetch({ url }) {
      return {
        url,
        statusCode: 200,
        body: {
          kind: 'html',
          content: `<html><head><title>${url}</title></head><body><main><p>Node 22 entered LTS in October 2025. Node 22 is active LTS and receives security updates until April 2027, after which it moves to maintenance and eventually end-of-life. Teams running new backend services should compare the remaining support window against their own upgrade cadence before committing to a major version. ${url}</p></main></body></html>`,
        },
      }
    },
  }
  const calls = { llm: 0 }
  const llm = {
    stream(options) {
      calls.llm += 1
      const prompt = options.messages?.[0]?.content?.[0]?.text ?? ''
      let text = '{}'
      if (prompt.includes('<untrusted>')) {
        text = JSON.stringify([
          { claim: 'Node 22 是当前 LTS 版本', quote: 'Node 22 entered LTS', source: 0, type: 'docs', stance: 'support' },
          { claim: 'Node 22 是当前 LTS 版本', quote: 'Node 22 is active LTS', source: 1, type: 'docs', stance: 'support' },
        ])
      } else if (prompt.includes('拆解')) {
        text = JSON.stringify({ subQuestions: [{ q: 'Node LTS 版本' }], constraints: [], criteria: [], language: 'zh' })
      } else if (prompt.includes('研究简报')) {
        text = '## 结论\nNode 22 是当前 LTS [S1][S2]。\n\n## 置信度\nhigh\n\n## 未解决\n无'
      }
      return (async function* emit() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const services = {
    web,
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  const skills = []
  services.skills = { register: (skill) => { skills.push(skill); return () => {} } }
  const ctx = {
    get: (name) => services[name],
    tools: { register: (definition) => { registered[definition.name] = definition } },
  }
  apply(ctx, {
    engines: { ddgHtml: false },
    verticals: { github: false, arxiv: false, stackexchange: false, npm: false, hn: false, pypi: false, docs: false },
    pageFetcher: 'auto',
    timeoutMs: 5000,
  })
  return { registered, skills, calls }
}

test('apply registers research and end-to-end execute returns a cited brief', async () => {
  const { registered } = fakeHarness()
  const tool = registered.research
  assert.ok(tool, 'research tool registered')
  assert.equal(tool.parameters.question.required, true)

  const result = await tool.execute(
    { question: 'Node 22 是 LTS 吗？项目该用哪个版本', depth: 'standard' },
    { agent: { id: 'test-agent' } },
  )
  assert.equal(result.partial, false)
  // a.com/b.com/c.com are second-hand hosts: the pipeline must not claim high/medium.
  assert.equal(result.confidence, 'low')
  assert.ok(result.gaps.some((gap) => /一手或高质量来源/.test(gap)))
  assert.match(result.brief, /## 参考/)
  assert.match(result.brief, /\[S1\]/)
  assert.ok(result.sources.length >= 2)
  // The host rejects tool results that JSON.stringify would alter (undefined/NaN).
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)))
})

test('apply registers the research protocol skill when the service exists', () => {
  const { skills } = fakeHarness()
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'research-protocol')
  assert.equal(skills[0].source, 'runtime')
  assert.equal(skills[0].invocation.modelInvocable, true)
  assert.match(skills[0].content, /confidence/)
})

test('execute rejects empty questions', async () => {
  const { registered } = fakeHarness()
  await assert.rejects(() => registered.research.execute({ question: ' ' }, {}), /question/)
})

test('a repeated identical question is served from cache without another LLM call', async () => {
  const { registered, calls } = fakeHarness()
  const tool = registered.research
  const args = { question: 'Node 22 是 LTS 吗？项目该用哪个版本', depth: 'standard' }
  const first = await tool.execute(args, { agent: { id: 'cache-agent' } })
  const llmCallsAfterFirst = calls.llm
  const second = await tool.execute({ ...args }, { agent: { id: 'cache-agent' } })
  assert.equal(second.stats.cached, true)
  assert.equal(calls.llm, llmCallsAfterFirst, 'cache hit must not call the model again')
  assert.match(second.brief, /^> 本结果来自 \d+ 分钟前的缓存/)
  assert.equal(second.brief.replace(/^> .*\n\n/, ''), first.brief)
  assert.equal(second.sources.length, first.sources.length)
  // The cached copy still has to survive the host's lossless-JSON check.
  assert.deepEqual(second, JSON.parse(JSON.stringify(second)))
})

test('focus is part of the cache key', async () => {
  const { registered, calls } = fakeHarness()
  const tool = registered.research
  const question = 'Node 22 是 LTS 吗？项目该用哪个版本'
  await tool.execute({ question, depth: 'standard', focus: ['稳定性'] }, {})
  const afterFirst = calls.llm
  await tool.execute({ question, depth: 'standard', focus: ['迁移成本'] }, {})
  assert.ok(calls.llm > afterFirst, 'a different focus must not reuse the cached brief')
})

test('a follow-up with context bypasses the cache', async () => {
  const { registered, calls } = fakeHarness()
  const tool = registered.research
  const args = { question: '上面第 2 条展开说说', depth: 'quick', context: '上一轮：Node 22 于 2027-04-30 EOL。' }
  await tool.execute(args, { agent: { id: 'follow-agent' } })
  const afterFirst = calls.llm
  const second = await tool.execute({ ...args }, { agent: { id: 'follow-agent' } })
  assert.ok(calls.llm > afterFirst, 'a contextual follow-up must run again')
  assert.equal(second.stats.cached, undefined)
})

test('time-sensitive questions are never served from cache', async () => {
  const { registered, calls } = fakeHarness()
  const tool = registered.research
  const args = { question: '现在 Node 最新 LTS 是哪个版本', depth: 'quick' }
  const first = await tool.execute(args, { agent: { id: 'fresh-agent' } })
  const afterFirst = calls.llm
  const second = await tool.execute({ ...args }, { agent: { id: 'fresh-agent' } })
  assert.ok(calls.llm > afterFirst, 'a "latest" question must re-run instead of reusing the cache')
  assert.equal(second.stats.cached, undefined)
})

test('cache hits are announced in the brief, not hidden behind debugStats', async () => {
  const { registered } = fakeHarness()
  const tool = registered.research
  const args = { question: 'pnpm 和 yarn 的 workspace 差异', depth: 'quick' }
  await tool.execute(args, { agent: { id: 'note-agent' } })
  const hit = await tool.execute({ ...args }, { agent: { id: 'note-agent' } })
  assert.equal(hit.stats.cached, true)
  assert.match(hit.brief, /^> 本结果来自 \d+ 分钟前的缓存/)
  assert.equal(typeof hit.stats.cachedAgeMinutes, 'number')
})

test('cache can be disabled through config', async () => {
  const registered = {}
  const services = {
    web: {
      async search() {
        return { sources: [{ url: 'https://a.com/1', title: 'Node LTS release notes', snippet: 'Node 22 is LTS.' }] }
      },
      async fetch() {
        return { url: 'https://a.com/1', statusCode: 200, body: { kind: 'text', content: 'Node 22 entered LTS in October 2025 and stays supported until April 2027. '.repeat(3) } }
      },
    },
    llm: {
      stream() {
        const text = '## 结论\nNode 22 是 LTS [S1]。\n\n## 置信度\nmedium\n\n## 未解决\n无'
        return (async function* emit() { yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } } })()
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
  apply({
    get: (name) => services[name],
    tools: { register: (definition) => { registered[definition.name] = definition } },
  }, {
    engines: { ddgHtml: false },
    verticals: { github: false, arxiv: false, stackexchange: false, npm: false, hn: false, pypi: false, docs: false },
    pageFetcher: 'auto',
    timeoutMs: 5000,
    cache: { enabled: false },
  })
  const question = 'Node 22 是 LTS 吗？'
  await registered.research.execute({ question, depth: 'quick' }, {})
  const result = await registered.research.execute({ question, depth: 'quick' }, {})
  assert.equal(result.stats.cached, undefined)
})

test('a follow-up can reuse the previous run pages through researchId', async () => {
  const { registered } = fakeHarness()
  const tool = registered.research
  const first = await tool.execute({ question: 'Node 22 支持到什么时候', depth: 'quick' }, { agent: { id: 'follow-agent' } })
  assert.match(first.researchId, /^rs_[0-9a-f]{16}$/)
  assert.match(first.brief, new RegExp(`研究会话：${first.researchId}`))
  const second = await tool.execute({ question: '它的维护期什么时候开始', depth: 'quick', researchId: first.researchId }, { agent: { id: 'follow-agent' } })
  assert.equal(second.stats.resumed, true)
  assert.ok(second.stats.reusedPages >= 1)
  assert.match(second.brief, /复用 \d+ 页/)
  assert.match(second.researchId, /^rs_[0-9a-f]{16}$/)
  assert.notEqual(second.researchId, first.researchId)
})

test('saveTo writes the brief to disk and returns the absolute path', async () => {
  const { registered } = fakeHarness()
  const target = join(tmpdir(), `gr-brief-${Date.now()}.md`)
  const result = await registered.research.execute({ question: 'Node 22 支持到什么时候', depth: 'quick', saveTo: target }, {})
  assert.equal(result.savedTo, target)
  const text = await readFile(target, 'utf8')
  assert.match(text, /## 结论/)
  assert.match(text, /## 参考/)
})

test('an unknown researchId falls back to a fresh run instead of failing', async () => {
  const { registered } = fakeHarness()
  const result = await registered.research.execute({ question: 'Node 22 支持到什么时候', depth: 'quick', researchId: 'rs_deadbeefdeadbeef' }, {})
  assert.equal(result.stats.resumed, false)
  assert.ok(result.brief.length > 0)
})