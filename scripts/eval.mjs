#!/usr/bin/env node
/**
 * eval.mjs — 可度量评测（1.1.0）。
 *
 * Why this exists: every other check says whether the pipeline *finished*
 * (`e2e-real`) or what it *retrieved* (`retrieval-check`). Neither answers the
 * only question a release decision needs: "did this change make the reports
 * better or worse?" This script runs a fixed 10-question corpus through the real
 * `runResearch` and reduces each run to a 0–100 score built from six weighted
 * metrics, so two versions can be compared as a table instead of an opinion.
 *
 *   node scripts/eval.mjs --offline                 # 内置 fixture，不联网，自检评分器
 *   node scripts/eval.mjs --real --only a-rag       # 真引擎 + 真抓取 + 模板合成
 *   node scripts/eval.mjs --real --json out.json --baseline prev.json
 *
 * Two things are deliberately fixed so a score difference means the pipeline
 * changed, not the test:
 *   - the corpus (`QUESTIONS`) is inlined and never fetched;
 *   - the model is replaced by a deterministic template (no LLM), exactly like
 *     `retrieval-check.mjs`. --offline replaces the network too, so it measures
 *     the scorer itself (and runs in CI); --real keeps the network and therefore
 *     measures retrieval/selection quality.
 *
 * Scoring is `scoreRun()`: a pure function of the brief, the adopted sources and
 * the run stats. Weights (sum 100):
 *   来源质量 30 · 表格填充 20 · 段完整 15 · 四数 10 · 置信度合理性 15 · 时效/预算 10
 * A metric that does not apply to a question (e.g. no compare table for a
 * fresh-data question) is dropped and the remaining weights are renormalised, so
 * each question still scores out of 100.
 *
 * Exit codes: 0 = pass; 1 = total score is 3+ points below --baseline, or the run
 * failed; 2 = bad arguments. No network happens unless --real is passed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEPTH_PROFILES, compareOptions, runResearch } from '../lib/pipeline.js'
import { QUESTION_KINDS } from '../lib/strategies.js'
import { classify } from '../lib/strategy.js'
import { domainOf, isOfficialDomain, normalizeUrl, sourceTier } from '../lib/util.js'
import { createFakeLlm, createRealHarness, resolveTavilyKey } from './lib/harness.mjs'

export const EVAL_VERSION = '1.1.0'
export const REPORT_SCHEMA = 1

/** Weights sum to 100; a skipped metric renormalises the rest (see weightedScore). */
export const WEIGHTS = Object.freeze({
  sourceQuality: 30,
  tableFill: 20,
  sections: 15,
  fourNumbers: 10,
  confidence: 15,
  budget: 10,
})

/** 3 points is the regression threshold: CI fails when the total drops more than this. */
export const REGRESSION_MARGIN = 3

const BASE_SECTIONS = Object.freeze(['## 结论', '## 依据', '## 置信度', '## 未解决'])
const CONFIDENCE_RANK = Object.freeze({ low: 0, medium: 1, high: 2 })

/**
 * The fixed corpus. `expectKind` is an assertion on the classifier, reported as a
 * warning only: a wrong kind is a finding, not a scoring failure (the scorer
 * measures the report, not the label).
 */
export const QUESTIONS = Object.freeze([
  Object.freeze({ id: 'a-rag', question: 'Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选', depth: 'standard', mode: 'compare', expectKind: 'tech-selection' }),
  Object.freeze({ id: 'b-price', question: '国内大模型 API 价格对比：qwen、豆包、deepseek、GLM 哪家便宜', depth: 'standard', mode: 'compare', expectKind: 'pricing' }),
  Object.freeze({ id: 'c-split', question: '8 人团队做微服务，现在该不该拆服务', depth: 'standard', mode: '', expectKind: 'decision' }),
  Object.freeze({ id: 'd-node', question: 'Node.js 最新 LTS 支持到什么时候', depth: 'quick', mode: '', expectKind: 'fresh-data' }),
  Object.freeze({ id: 'e-so', question: '虚拟线程 pinning 问题，Stack Overflow 高票回答怎么说的', depth: 'quick', mode: '', expectKind: 'troubleshoot' }),
  Object.freeze({ id: 'f-legal', question: '欧盟网络弹性法案（CRA）对嵌入式设备厂商有哪些义务', depth: 'standard', mode: '', expectKind: 'legal' }),
  Object.freeze({ id: 'g-learn', question: '如何系统学习 Java 后端开发', depth: 'quick', mode: '', expectKind: 'learning' }),
  Object.freeze({ id: 'h-compare-zh', question: 'MySQL 和 PostgreSQL 选哪个', depth: 'standard', mode: '', expectKind: 'tech-selection' }),
  Object.freeze({ id: 'i-paper', question: 'RAG 长上下文检索的近年论文', depth: 'quick', mode: '', expectKind: 'scholar' }),
  Object.freeze({ id: 'j-eval', question: '8 人团队要不要上 Kubernetes', depth: 'standard', mode: '', expectKind: 'decision' }),
])

/**
 * --offline fixtures: one page list per question id.
 *
 * Two constraints come from the pipeline itself, not from taste:
 *   - `heuristicEvidence()` takes the FIRST paragraph of a page as its single
 *     evidence claim, so fixture text is one paragraph naming the option;
 *   - for a compare run, an option mentioned by no page is treated as zero
 *     evidence and its whole table row is replaced by 无证据. So the same set of
 *     names must appear in the fixture pages and in the fixture brief's table.
 * `option` indexes into `compareOptions(question)` (the pipeline's own option
 * extraction), which keeps the row labels and the page text in sync.
 */
const OFFLINE_FIXTURES = Object.freeze({
  'a-rag': {
    sources: [
      { url: 'https://docs.spring.io/spring-ai/reference/api/chatclient.html', title: 'Spring AI ChatClient 参考', option: 0 },
      { url: 'https://docs.langchain4j.dev/tutorials/rag/', title: 'LangChain4j RAG 教程', option: 1 },
      { url: 'https://haystack.deepset.ai/docs/pipelines', title: 'Haystack Pipelines 文档', option: 2 },
      { url: 'https://stackoverflow.com/questions/76012345/spring-ai-vs-langchain4j', title: 'Spring AI 与 LangChain4j 对比（社区）', option: 1 },
    ],
  },
  'b-price': {
    sources: [
      { url: 'https://help.aliyun.com/zh/model-studio/models', title: '阿里云百炼模型价格', option: 0 },
      { url: 'https://www.volcengine.com/docs/82379/1099320', title: '火山引擎豆包模型价格', option: 1 },
      { url: 'https://api-docs.deepseek.com/quick_start/pricing', title: 'DeepSeek API 价格', option: 2 },
      { url: 'https://zhuanlan.zhihu.com/p/000000001', title: '四家大模型价格实测（社区）', option: 1 },
    ],
  },
  'c-split': {
    topic: '微服务拆分',
    sources: [
      { url: 'https://martinfowler.com/articles/microservices.html', title: 'Microservices' },
      { url: 'https://martinfowler.com/bliki/MicroservicePremium.html', title: 'Microservice Premium' },
      { url: 'https://learn.microsoft.com/zh-cn/dotnet/architecture/microservices/', title: '微服务架构指南' },
    ],
  },
  'd-node': {
    topic: 'Node.js LTS',
    sources: [
      { url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js Previous Releases' },
      { url: 'https://github.com/nodejs/Release', title: 'nodejs/Release' },
      { url: 'https://endoflife.date/nodejs', title: 'endoflife.date: Node.js' },
    ],
  },
  'e-so': {
    topic: '虚拟线程 pinning',
    sources: [
      { url: 'https://stackoverflow.com/questions/76973189/virtual-threads-pinning', title: 'Virtual threads pinning（高票回答）' },
      { url: 'https://openjdk.org/jeps/444', title: 'JEP 444: Virtual Threads' },
      { url: 'https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html', title: 'Java 21 Virtual Threads 文档' },
    ],
  },
  'f-legal': {
    topic: '欧盟 CRA 义务',
    sources: [
      { url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj', title: 'Regulation (EU) 2024/2847' },
      { url: 'https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act', title: 'Cyber Resilience Act 政策页' },
      { url: 'https://www.bsi.bund.de/EN/Themen/Unternehmen-und-Organisationen/Cyber-Sicherheit/CRA/cra_node.html', title: 'BSI：CRA 说明' },
    ],
  },
  'g-learn': {
    topic: 'Java 后端学习路线',
    sources: [
      { url: 'https://docs.oracle.com/javase/tutorial/', title: 'Java Tutorials' },
      { url: 'https://spring.io/guides', title: 'Spring Guides' },
      { url: 'https://roadmap.sh/java', title: 'Java 学习路线（社区）' },
    ],
  },
  'h-compare-zh': {
    topic: 'MySQL 与 PostgreSQL',
    sources: [
      { url: 'https://dev.mysql.com/doc/refman/8.4/en/', title: 'MySQL 8.4 参考手册' },
      { url: 'https://www.postgresql.org/docs/current/', title: 'PostgreSQL 文档' },
      { url: 'https://www.postgresql.org/about/', title: 'PostgreSQL 特性概览' },
    ],
  },
  'i-paper': {
    topic: 'RAG 长上下文检索论文',
    sources: [
      { url: 'https://arxiv.org/abs/2404.16130', title: 'RAG 长上下文检索（arXiv）' },
      { url: 'https://aclanthology.org/2024.acl-long.1/', title: 'ACL 2024 长文' },
      { url: 'https://arxiv.org/abs/2310.11511', title: '检索增强生成综述（arXiv）' },
    ],
  },
  'j-eval': {
    topic: 'Kubernetes 落地',
    sources: [
      { url: 'https://kubernetes.io/docs/concepts/overview/', title: 'Kubernetes 概览' },
      { url: 'https://kubernetes.io/docs/setup/best-practices/cluster-large/', title: 'Kubernetes 大规模集群最佳实践' },
      { url: 'https://kubernetes.io/docs/tasks/run-application/run-stateless-application-deployment/', title: '运行无状态应用' },
    ],
  },
})

// ---------------------------------------------------------------- small utils

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const round1 = (value) => Math.round(Number(value) * 10) / 10 || 0
const round3 = (value) => Math.round(Number(value) * 1000) / 1000 || 0
const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0))
const percent = (ratio) => (ratio === null || ratio === undefined ? '—' : `${Math.round(Number(ratio) * 100)}%`)

// ------------------------------------------------------------- pure scoring

/**
 * Official-source share of the adopted sources: a `doc-page`/`doc-index`/
 * `repo-doc` tier or an official domain (`.gov`, vendor docs host, …). Repo code
 * files are deliberately *not* official — a source file is evidence, not a spec.
 */
export function officialSourceRatio(sources = []) {
  const list = (Array.isArray(sources) ? sources : []).filter(Boolean)
  if (list.length === 0) return { total: 0, official: 0, ratio: 0 }
  let official = 0
  for (const source of list) {
    const url = typeof source === 'string' ? source : source?.url
    const tier = sourceTier(url)
    if (tier === 'doc-page' || tier === 'doc-index' || tier === 'repo-doc' || isOfficialDomain(url)) official += 1
  }
  return { total: list.length, official, ratio: official / list.length }
}

/** Split one Markdown table row into cells (lib/brief.js keeps its splitter private). */
export function splitTableRow(line) {
  const text = String(line ?? '').trim()
  if (!text.startsWith('|')) return null
  const cells = text.split('|')
  cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

export function isTableSeparator(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell))
}

/** The first table under `## 方案对比`, as `{header, rows}`; null when absent. */
export function parseCompareTable(brief = '') {
  let inside = false
  let header = null
  const rows = []
  for (const raw of String(brief ?? '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw.trim())
    if (heading) {
      inside = heading[1] === '方案对比'
      continue
    }
    if (!inside) continue
    const cells = splitTableRow(raw)
    if (!cells || cells.length === 0) continue
    if (!header) {
      header = cells
      continue
    }
    if (isTableSeparator(cells)) continue
    rows.push(cells)
  }
  if (!header) return null
  return { header, rows }
}

/**
 * Share of evaluation cells (everything except the row label) that carry real
 * evidence: non-empty and not the pipeline's 无证据 placeholder.
 */
export function tableFillRate(table) {
  if (!table || table.rows.length === 0) return { rate: 0, cells: 0, filled: 0 }
  let cells = 0
  let filled = 0
  for (const row of table.rows) {
    for (let index = 1; index < row.length; index += 1) {
      const cell = row[index] ?? ''
      cells += 1
      if (cell !== '' && !cell.includes('无证据')) filled += 1
    }
  }
  return { rate: cells === 0 ? 0 : filled / cells, cells, filled }
}

/**
 * Sections this question must have. `## 结论/依据/置信度/未解决` are the base
 * contract; decision questions also owe `## 判据`, and compare-mode /
 * tech-selection / learning / decision answers owe `## 行动清单`
 * (lib/brief.js requiredSectionsFor has the same rules).
 */
export function requiredSectionsFor(kind = '', mode = '') {
  const sections = [...BASE_SECTIONS]
  if (kind === 'decision') sections.push('## 判据')
  if (mode === 'compare' || kind === 'decision' || kind === 'tech-selection' || kind === 'learning') sections.push('## 行动清单')
  return sections
}

export function missingSections(brief = '', sections = []) {
  const text = String(brief ?? '')
  return sections.filter((heading) => !new RegExp(`^${escapeRegex(heading)}\\s*$`, 'm').test(text))
}

/** The four funnel numbers must be present, and 采用 must be non-zero. */
export function fourNumbersComplete(stats = {}) {
  const keys = ['identified', 'deduped', 'readable', 'adopted']
  const values = keys.map((key) => stats?.[key])
  const complete = values.every((value) => typeof value === 'number' && Number.isFinite(value))
  const adopted = Number(stats?.adopted ?? 0)
  return { complete, adoptedOk: adopted > 0, rate: complete && adopted > 0 ? 1 : 0, values, adopted }
}

/**
 * Which confidence the evidence actually supports. "High" is deliberately hard:
 * half the sources official AND at least five adopted sources (the pipeline's own
 * gates are similarly strict — a 3-source run is not high-confidence evidence).
 * Thin evidence should say low; everything in between medium.
 */
export function expectedConfidence({ officialRatio = 0, adopted = 0 } = {}) {
  if (officialRatio >= 0.5 && adopted >= 5) return 'high'
  if (officialRatio < 0.4 || adopted < 2) return 'low'
  return 'medium'
}

/** 1 point for a match, 0.5 for one level off, 0.15 for two. */
export function confidencePoints(actual = 'low', expected = 'low') {
  const distance = Math.abs((CONFIDENCE_RANK[actual] ?? 0) - (CONFIDENCE_RANK[expected] ?? 0))
  if (distance === 0) return 1
  if (distance === 1) return 0.5
  return 0.15
}

/** 1 when the run finished inside the depth's wall clock and was not partial. */
export function budgetPoints({ partial = false, seconds = 0, depth = 'standard' } = {}) {
  const wallMs = DEPTH_PROFILES[depth]?.wallMs ?? DEPTH_PROFILES.standard.wallMs
  if (partial) return { rate: 0, wallMs, note: 'partial=true（本次未在预算内收敛）' }
  const usedMs = Math.max(0, Number(seconds) || 0) * 1000
  if (usedMs > wallMs) return { rate: 0, wallMs, note: `耗时 ${Math.round(usedMs)}ms 超过 ${wallMs}ms 档位墙钟` }
  return { rate: 1, wallMs, note: '' }
}

/** Weighted 0–100 score; `null` ratios (metric not applicable) are dropped. */
export function weightedScore(components = {}) {
  let points = 0
  let weightUsed = 0
  for (const [key, part] of Object.entries(components)) {
    const ratio = part?.ratio
    if (ratio === null || ratio === undefined) continue
    const weight = WEIGHTS[key] ?? Number(part?.weight) ?? 0
    points += weight * clamp01(ratio)
    weightUsed += weight
  }
  return { score: weightUsed === 0 ? 0 : round1((points / weightUsed) * 100), weightUsed }
}

const component = (ratio, weight) => ({ ratio, weight })

/**
 * Score one run. Pure: only the brief text, the adopted sources and the run stats
 * go in, a 0–100 record comes out. Every deduction leaves a note so the table is
 * explainable instead of a bare number.
 */
export function scoreRun(input = {}) {
  const {
    brief = '',
    sources = [],
    stats = {},
    confidence = 'low',
    kind = '',
    mode = '',
    depth = 'standard',
    partial = false,
    seconds = 0,
  } = input
  const notes = [...(input.notes ?? [])]

  const official = officialSourceRatio(sources)
  if (official.total === 0) notes.push('来源：采用 0 条来源，来源质量按 0 计')

  const table = parseCompareTable(brief)
  const needsTable = mode === 'compare' || kind === 'pricing' || kind === 'tech-selection'
  let tableRatio = null
  if (table) {
    const fill = tableFillRate(table)
    tableRatio = fill.rate
    if (needsTable && fill.rate < 1) notes.push(`表格：${fill.filled}/${fill.cells} 个评估格有证据`)
  } else if (needsTable) {
    tableRatio = 0
    notes.push('表格：该题应有「## 方案对比」对比表，但简报里没有')
  }

  const required = requiredSectionsFor(kind, mode)
  const missing = missingSections(brief, required)
  const sectionsComplete = missing.length === 0
  if (!sectionsComplete) notes.push(`段落缺失：${missing.join('、')}`)

  const four = fourNumbersComplete(stats)
  if (!four.complete) notes.push('四数：identified / deduped / readable / adopted 不全')
  else if (!four.adoptedOk) notes.push('四数：adopted=0（没有可用来源）')

  const adopted = Number.isFinite(four.adopted) ? four.adopted : official.total
  const expected = expectedConfidence({ officialRatio: official.ratio, adopted })
  const confidenceMatch = expected === confidence
  if (!confidenceMatch) {
    notes.push(`置信度：报 ${confidence}，按证据（官方占比 ${percent(official.ratio)}、采用 ${adopted} 条）应报 ${expected}`)
  }

  const budget = budgetPoints({ partial, seconds, depth })
  if (budget.note) notes.push(`预算：${budget.note}`)

  const components = {
    sourceQuality: component(official.ratio, WEIGHTS.sourceQuality),
    tableFill: component(tableRatio, WEIGHTS.tableFill),
    sections: component(required.length === 0 ? 1 : (required.length - missing.length) / required.length, WEIGHTS.sections),
    fourNumbers: component(four.rate, WEIGHTS.fourNumbers),
    confidence: component(confidencePoints(confidence, expected), WEIGHTS.confidence),
    budget: component(budget.rate, WEIGHTS.budget),
  }
  const { score, weightUsed } = weightedScore(components)

  return {
    kind,
    mode,
    sources: (Array.isArray(sources) ? sources : []).length,
    officialRatio: round3(official.ratio),
    tableFillRate: tableRatio === null ? null : round3(tableRatio),
    sectionsComplete,
    sectionsMissing: missing,
    fourNumbers: four.rate === 1,
    confidence,
    expectedConfidence: expected,
    confidenceMatch,
    seconds: round1(seconds),
    partial: Boolean(partial),
    depth,
    score,
    weightUsed,
    components,
    notes,
  }
}

/** Score a finished `runResearch` result against its corpus question. */
export function scoreResult(question, result, { seconds = 0 } = {}) {
  const stats = result?.stats ?? {}
  const kind = String(stats.questionKind ?? '')
  const mode = String(question?.mode || stats.mode || '')
  const expectKind = String(question?.expectKind ?? '')
  const notes = []
  if (expectKind) {
    if (!QUESTION_KINDS.includes(expectKind)) {
      notes.push(`分类：分类器没有 kind「${expectKind}」（合法值 ${QUESTION_KINDS.join(' / ')}），跳过这条断言`)
    } else if (kind !== expectKind) {
      notes.push(`分类：判成「${kind || '未知'}」，语料期望「${expectKind}」（仅提示，不影响评分）`)
    }
  }
  const scored = scoreRun({
    brief: result?.brief ?? '',
    sources: result?.sources ?? [],
    stats,
    confidence: String(result?.confidence ?? 'low'),
    kind,
    mode,
    depth: question?.depth ?? 'standard',
    partial: Boolean(result?.partial),
    seconds,
    notes,
  })
  return { id: question?.id ?? 'run', question: question?.question ?? '', expectKind, ...scored }
}

// ----------------------------------------------------------- offline fixture

/** One paragraph: heuristicEvidence() reads the first paragraph only. */
function fixturePageText(name) {
  return `${name} 的离线 fixture 页面（1.1.0 评测语料，不是真实抓取）：适用场景是 8 人左右团队的 RAG 后端，接入成本约 0.2 元/百万 tokens，响应延迟 12 毫秒；支持周期到 2027 年 4 月，迁移成本约 3 人周，主要风险是生态较新。团队规模阈值大约在 10 人，超过之后再拆分服务更划算，这条经验来自社区复盘与官方迁移指南的对照。`
}

function fixturePages(question) {
  const fixture = OFFLINE_FIXTURES[question.id] ?? { sources: [] }
  const options = compareOptions(question.question)
  return fixture.sources.map((entry) => {
    const option = entry.option === undefined ? undefined : options[entry.option]
    const name = option ?? fixture.topic ?? question.question
    return {
      url: entry.url,
      finalUrl: entry.url,
      title: entry.title,
      domain: domainOf(entry.url),
      text: fixturePageText(name),
      ok: true,
      publishedAt: '2025-10-01',
      via: 'search',
    }
  })
}

function fixtureEngine(pages) {
  return {
    name: 'eval-fixture',
    available: () => true,
    search: async () => pages.map((page, index) => ({
      url: page.url,
      title: page.title,
      snippet: page.text.slice(0, 80),
      engine: 'eval-fixture',
      rank: index + 1,
    })),
  }
}

function fixtureFetchPage(pages) {
  // The pipeline normalises hit URLs before fetching (trailing slash dropped,
  // host lowercased), so the lookup has to accept both spellings.
  const byUrl = new Map()
  for (const page of pages) {
    byUrl.set(page.url, page)
    byUrl.set(normalizeUrl(page.url), page)
  }
  return async (url) => byUrl.get(url) ?? byUrl.get(normalizeUrl(url)) ?? { url, ok: false, error: 'offline-fixture-miss' }
}

/** Fixture brief: sections the scorer requires, plus a citeable table for compare runs. */
function fixtureBrief(question, options) {
  const cites = '[S1][S2][S3][S4][S5][S6][S7][S8]'
  // Same rule the scorer applies: a table is only owed by compare runs and the
  // two table-shaped kinds. Producing one elsewhere would be scored as sloppy.
  const { mode, questionKind } = classify({ question: question.question, mode: question.mode || undefined })
  const compare = mode === 'compare' || questionKind === 'pricing' || questionKind === 'tech-selection'
  const first = options[0] ?? '首选方案'
  const last = options[options.length - 1] ?? '备选方案'
  const lines = [
    '## 结论',
    `${question.question}：离线 fixture 结论，按官方文档与社区证据优先 ${first}，把 ${last} 作为迁移备选。${cites}`,
    '',
    '## 依据',
    '- 官方文档给出支持周期、成本与适用场景 [S1]',
    '- 社区来源补充失败案例与迁移成本 [S2]',
    '- 次优来源给出团队规模阈值 [S3]',
    '',
  ]
  if (compare) {
    lines.push('## 方案对比', '| 方案 | 适用场景 | 成本概览 | 风险 |', '| --- | --- | --- | --- |')
    options.slice(0, 4).forEach((option, index) => {
      lines.push(`| ${option} | 8 人左右团队适用 [S${index + 1}] | 约 0.2 元/百万 tokens [S${index + 2}] | 生态较新，迁移约 3 人周 [S${index + 3}] |`)
    })
    lines.push('')
  }
  lines.push(
    '## 判据',
    '- 团队规模与迁移成本是否匹配 [S1]',
    '',
    '## 行动清单',
    '- 先用一条链路试点，再决定是否全量迁移 [S2]',
    '',
    '## 坑与风险',
    '生态较新，迁移窗口有限，需要保留回滚方案。',
    '',
    '## 置信度',
    'medium',
    '',
    '## 未解决',
    '缺少生产环境基准数据。',
  )
  return lines.join('\n')
}

/** Fake model for --offline: same three prompt shapes as the pipeline asks. */
function offlineLlm(question, options) {
  const brief = fixtureBrief(question, options)
  return createFakeLlm((prompt) => {
    if (prompt.includes('检索计划')) return JSON.stringify({ queries: [{ q: question.question, kind: 'semantic' }], directUrls: [] })
    if (prompt.includes('拆解')) return JSON.stringify({ subQuestions: [{ q: question.question, why: '评测固定子问题', evidence: 'web' }], constraints: [], language: 'zh' })
    if (prompt.includes('研究简报')) return brief
    if (prompt.includes('证据')) return '[]'
    return brief
  })
}

/**
 * Run the corpus with fake engines/pages and a fixture model: no network, no LLM.
 * This is the CI mode — it proves the scorer produces a table and stays 0-exit.
 */
export async function runOffline(questions = QUESTIONS, { logger = () => {} } = {}) {
  const runs = []
  for (const question of questions) {
    const options = compareOptions(question.question)
    const pages = fixturePages(question)
    const config = { enabled: true, maxDeepPerSession: 3, __engines: [fixtureEngine(pages)], __fetchPage: fixtureFetchPage(pages) }
    const startedAt = Date.now()
    const result = await runResearch({
      question: question.question,
      depth: question.depth,
      mode: question.mode || undefined,
      config,
      web: undefined,
      llm: offlineLlm(question, options),
      selection: { provider: 'eval-offline', model: 'eval-offline-fixture' },
      logger,
      signal: AbortSignal.timeout(DEPTH_PROFILES[question.depth]?.wallMs ?? DEPTH_PROFILES.standard.wallMs),
    })
    runs.push({ question, result, seconds: (Date.now() - startedAt) / 1000 })
  }
  return runs
}

// -------------------------------------------------------------- real fixtures

/**
 * Deterministic synthesis template for --real: same sections as a real brief and,
 * for compare questions, one table row per option. Zero-evidence options are
 * blanked to 无证据 by the pipeline, which is exactly what 表格填充 measures —
 * text quality is out of scope here (that is what the model itself is for).
 */
function templateBrief(question, options) {
  const { mode, questionKind } = classify({ question: question.question, mode: question.mode || undefined })
  const needsTable = mode === 'compare' || questionKind === 'pricing' || questionKind === 'tech-selection'
  const lines = [
    '## 结论',
    `eval.mjs --real 的确定性模板（不用 LLM）：${question.question} 的结论位置，只让评分器读到结构，不代表内容质量。[S1][S2][S3][S4][S5][S6][S7][S8]`,
    '',
    '## 依据',
    '- 模板依据 1 [S1]',
    '- 模板依据 2 [S2]',
    '- 模板依据 3 [S3]',
    '',
  ]
  if (needsTable && options.length >= 2) {
    lines.push('## 方案对比', '| 方案 | 适用场景 | 成本概览 | 风险 |', '| --- | --- | --- | --- |')
    options.slice(0, 4).forEach((option, index) => {
      lines.push(`| ${option} | 模板占位 [S${index + 1}] | 模板占位 [S${index + 2}] | 模板占位 [S${index + 3}] |`)
    })
    lines.push('')
  }
  lines.push(
    '## 判据',
    '- 模板判据 [S1]',
    '',
    '## 行动清单',
    '- 模板行动 [S1]',
    '',
    '## 坑与风险',
    '模板占位。',
    '',
    '## 置信度',
    'medium',
    '',
    '## 未解决',
    '模板占位。',
  )
  return lines.join('\n')
}

function templateLlm(question) {
  const options = compareOptions(question.question)
  const brief = templateBrief(question, options)
  return createFakeLlm((prompt) => {
    if (prompt.includes('检索计划')) return JSON.stringify({ queries: [{ q: question.question, kind: 'semantic' }], directUrls: [] })
    if (prompt.includes('拆解')) return JSON.stringify({ subQuestions: [{ q: question.question, why: '评测固定子问题', evidence: 'web' }], constraints: [], language: 'zh' })
    if (prompt.includes('研究简报')) return brief
    if (prompt.includes('证据')) return '[]'
    return brief
  })
}

/**
 * Run the corpus against the real engines and the real page fetcher, with the
 * deterministic template as the model. Network is required; each question is
 * capped at its depth wall clock plus a small grace period.
 */
export async function runReal(questions = QUESTIONS, { logger = console.error } = {}) {
  const tkey = resolveTavilyKey()
  if (!tkey.key) {
    logger('[eval] 未取到 tavily key（TAVILY_API_KEY 与 desktop profile 的 keys.tavily 都没有）：只用 ddg-html，被拦截时该题会退化。')
  }
  const { config, fetchRaw, engines, fetchPage } = createRealHarness({ tavilyKey: tkey.key, logger })
  if (engines.length === 0) throw new Error('没有可用引擎：至少保留 ddg-html，或配置 tavily key。')

  const runs = []
  for (const question of questions) {
    const wallMs = DEPTH_PROFILES[question.depth]?.wallMs ?? DEPTH_PROFILES.standard.wallMs
    const startedAt = Date.now()
    const result = await runResearch({
      question: question.question,
      depth: question.depth,
      mode: question.mode || undefined,
      config: { ...config, __engines: engines, __fetchPage: fetchPage, __fetchRaw: fetchRaw },
      web: undefined,
      llm: templateLlm(question),
      selection: { provider: 'eval', model: 'eval-template-llm' },
      logger,
      signal: AbortSignal.timeout(wallMs + 60000),
    })
    runs.push({ question, result, seconds: (Date.now() - startedAt) / 1000 })
  }
  return runs
}

// ------------------------------------------------------------------- report

export function buildReport(runs, { mode = 'offline', generatedAt = new Date().toISOString(), elapsedMs = 0 } = {}) {
  const records = runs.map(({ question, result, seconds }) => scoreResult(question, result, { seconds }))
  const total = records.length === 0 ? 0 : round1(records.reduce((sum, record) => sum + record.score, 0) / records.length)
  return {
    schema: REPORT_SCHEMA,
    tool: 'eval',
    version: EVAL_VERSION,
    generatedAt,
    mode,
    elapsedMs: Math.round(elapsedMs),
    weights: WEIGHTS,
    questions: records.length,
    total,
    records,
  }
}

/** Per-question and total deltas against a previous report; 3+ points lower regresses. */
export function compareToBaseline(report, baseline) {
  const previous = new Map(((baseline?.records) ?? []).filter(Boolean).map((record) => [record.id, record]))
  const items = (report?.records ?? []).map((record) => {
    const before = previous.get(record.id)
    const baselineScore = Number.isFinite(before?.score) ? before.score : null
    return {
      id: record.id,
      score: record.score,
      baseline: baselineScore,
      delta: baselineScore === null ? null : round1(record.score - baselineScore),
    }
  })
  const baselineTotal = Number.isFinite(baseline?.total)
    ? round1(baseline.total)
    : round1(items.reduce((sum, item) => sum + (item.baseline ?? 0), 0) / Math.max(1, items.filter((item) => item.baseline !== null).length))
  const totalDelta = round1(report.total - baselineTotal)
  const regressed = totalDelta <= -REGRESSION_MARGIN
  return { baselineTotal, totalDelta, regressed, exitCode: regressed ? 1 : 0, items }
}

export function renderMarkdown(report, comparison = null) {
  const lines = []
  const modeLabel = report.mode === 'real' ? 'real（真引擎 + 真抓取 + 模板合成）' : 'offline（内置 fixture）'
  lines.push(`# eval ${report.version} · ${modeLabel}`)
  lines.push('')
  lines.push(`生成于 ${report.generatedAt} · 语料 ${report.questions} 题 · 用时 ${(report.elapsedMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('| id | kind | 来源 | 官方 | 表格 | 段 | 四数 | 置信 | 秒 | 分 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const record of report.records) {
    const confidence = record.confidenceMatch ? record.confidence : `${record.confidence}→${record.expectedConfidence}`
    const sections = record.sectionsComplete ? '✓' : `${record.sectionsMissing.length} 缺`
    lines.push(
      `| ${record.id} | ${record.kind || '—'} | ${record.sources} | ${percent(record.officialRatio)} | ${percent(record.tableFillRate)} | ${sections} | ${record.fourNumbers ? '✓' : '✗'} | ${confidence} | ${record.seconds.toFixed(1)} | ${record.score.toFixed(1)} |`,
    )
  }
  lines.push('')
  lines.push(`**总分 ${report.total.toFixed(1)} / 100**（各题均值；不适用指标已剔除并按剩余权重归一）`)
  const noted = report.records.filter((record) => record.notes.length > 0)
  if (noted.length > 0) {
    lines.push('')
    lines.push('备注：')
    for (const record of noted) lines.push(`- **${record.id}**：${record.notes.join('；')}`)
  }
  if (comparison) {
    lines.push('')
    lines.push('## 对比 baseline')
    lines.push('')
    lines.push('| id | 当前 | 基线 | Δ |')
    lines.push('| --- | --- | --- | --- |')
    for (const item of comparison.items) {
      lines.push(`| ${item.id} | ${item.score.toFixed(1)} | ${item.baseline === null ? '—' : item.baseline.toFixed(1)} | ${item.delta === null ? '—' : `${item.delta >= 0 ? '+' : ''}${item.delta.toFixed(1)}`} |`)
    }
    lines.push('')
    const sign = comparison.totalDelta >= 0 ? '+' : ''
    lines.push(`总分差：${sign}${comparison.totalDelta.toFixed(1)}（baseline ${comparison.baselineTotal.toFixed(1)}；低 ${REGRESSION_MARGIN} 分以上判回归）`)
  }
  lines.push('')
  if (comparison?.regressed) {
    lines.push(`RESULT: FAIL（比 baseline 低 ${Math.abs(comparison.totalDelta).toFixed(1)} 分）`)
  } else {
    lines.push('RESULT: PASS')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------- CLI

export function parseArgs(argv = []) {
  const options = { mode: 'offline', only: [], json: '', jsonPath: '', baseline: '', help: false }
  const take = (inline, index) => {
    if (inline !== undefined) return { value: inline, next: index }
    const candidate = argv[index + 1]
    if (candidate !== undefined && !candidate.startsWith('--')) return { value: candidate, next: index + 1 }
    return { value: undefined, next: index }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] ?? '')
    const eq = raw.indexOf('=')
    const name = eq > 0 ? raw.slice(0, eq) : raw
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined
    if (name === '--offline') options.mode = 'offline'
    else if (name === '--real') options.mode = 'real'
    else if (name === '--help' || name === '-h') options.help = true
    else if (name === '--only') {
      const taken = take(inline, index)
      index = taken.next
      if (!taken.value) throw new Error('--only 需要一个题目 id（逗号分隔）')
      options.only.push(...taken.value.split(',').map((id) => id.trim()).filter(Boolean))
    } else if (name === '--json') {
      const taken = take(inline, index)
      index = taken.next
      if (taken.value) options.jsonPath = taken.value
      else options.json = 'stdout'
    } else if (name === '--baseline') {
      const taken = take(inline, index)
      index = taken.next
      if (!taken.value) throw new Error('--baseline 需要一个 JSON 报告路径')
      options.baseline = taken.value
    } else if (name === '--') continue
    else throw new Error(`未知参数：${raw}`)
  }
  return options
}

export function usage() {
  return [
    `eval ${EVAL_VERSION} — 可度量评测：固定 10 题，0–100 加权分数，可跨版本对比`,
    '',
    '用法：',
    '  node scripts/eval.mjs [--offline | --real] [--only a-rag,b-price] [--json out.json] [--baseline prev.json]',
    '',
    '模式：',
    '  --offline    默认。内置 fixture（假引擎 / 假页面 / 固定模板简报），不联网，自检评分器本身。',
    '  --real       真引擎 + 真抓取 + 确定性模板合成（不用 LLM），测真实检索/选页质量。单题可达数分钟。',
    '',
    '选项：',
    '  --only <ids>      只跑指定题目（逗号分隔），默认跑全部 10 题',
    '  --json [path]     带 path：JSON 报告落盘；不带 path：只把 JSON 打到 stdout',
    '  --baseline <path> 与上一版 JSON 报告对比，总分低 3 分以上退出码 1（CI 用）',
    '  --help            打印本帮助',
    '',
    `语料：${QUESTIONS.map((question) => question.id).join(' ')}`,
    '',
    '指标（权重）：来源质量 30 · 表格填充 20 · 段完整 15 · 四数 10 · 置信度合理性 15 · 时效/预算 10',
    '退出码：0 = 通过；1 = 比 baseline 低 3 分以上或运行失败；2 = 参数错误',
  ].join('\n')
}

function readBaseline(path) {
  const text = readFileSync(resolve(path), 'utf8')
  const parsed = JSON.parse(text)
  if (!parsed || !Array.isArray(parsed.records)) throw new Error(`${path} 不是 eval 的 JSON 报告（缺少 records 数组）`)
  return parsed
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[eval] ${error.message}`)
    console.error(usage())
    return 2
  }
  if (options.help) {
    console.log(usage())
    return 0
  }

  const known = new Set(QUESTIONS.map((question) => question.id))
  const unknown = options.only.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    console.error(`[eval] 未知题目：${unknown.join(', ')}；可用：${[...known].join(', ')}`)
    return 2
  }
  const questions = options.only.length > 0 ? QUESTIONS.filter((question) => options.only.includes(question.id)) : QUESTIONS.slice()
  if (questions.length === 0) {
    console.error('[eval] 没有可跑的题目')
    return 2
  }

  let baseline = null
  if (options.baseline) {
    try {
      baseline = readBaseline(options.baseline)
    } catch (error) {
      console.error(`[eval] baseline 读取失败：${error.message}`)
      return 2
    }
  }

  const startedAt = Date.now()
  let runs
  try {
    runs = options.mode === 'real' ? await runReal(questions) : await runOffline(questions)
  } catch (error) {
    console.error(`[eval] FAIL：${error?.message ?? error}`)
    return 1
  }

  const report = buildReport(runs, { mode: options.mode, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt })
  const comparison = baseline ? compareToBaseline(report, baseline) : null

  if (options.jsonPath) {
    const target = resolve(options.jsonPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.error(`[eval] 报告已写入 ${target}`)
  }
  if (options.json === 'stdout') {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderMarkdown(report, comparison))
  }
  return comparison ? comparison.exitCode : 0
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`[eval] FAIL：${error?.message ?? error}`)
      process.exitCode = 1
    })
}