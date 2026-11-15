/**
 * The one classifier and the one policy resolver.
 *
 * Before this module the pipeline guessed "what kind of question is this?" in six
 * unrelated places (autoDepth()'s two regexes, LEGAL_HINTS, the inline code-ish
 * regex inside buildQueries(), TIME_SENSITIVE in util.js, looksLikeFollowUp(),
 * and pickVerticals()' keyword table). Each one had its own vocabulary and its
 * own quirks. `classify()` keeps a single copy of every vocabulary and mirrors
 * those six judgements exactly, quirks included, so callers can read one result
 * instead of re-testing regexes. `resolveStrategy()` then maps the kind onto a
 * strategy pack (lib/strategies.js) relative to the current behaviour.
 *
 * Dependency direction: util.js -> strategy.js -> strategies.js. This module
 * must not import util.js (util re-exports isTimeSensitive from here).
 *
 * PR2 contract: classification is still pure (no LLM, no I/O) and the concept
 * pack / no pack behaves byte-for-byte as before; the other packs now drive the
 * query plan, the required brief sections, the confidence gates and the additive
 * ranking boosts. Fields nothing reads yet stay descriptive data.
 */
import {
  isKnownQuestionKind,
  KIND_PRIORITY,
  PRICING_SEEDS,
  QUESTION_KINDS,
  SIGNAL_VERSION,
  STRATEGIES,
  STRATEGY_DEFAULTS,
} from './strategies.js'

export { KIND_PRIORITY, PRICING_SEEDS, QUESTION_KINDS, SIGNAL_VERSION, STRATEGIES, STRATEGY_DEFAULTS, isKnownQuestionKind }

/** Depth ladder, shallow to deep. */
export const DEPTH_ORDER = Object.freeze(['quick', 'standard', 'deep'])

/** Accepted answer modes; anything else is normalised to `explain`. */
export const MODES = Object.freeze(['explain', 'compare', 'track', 'evaluate'])

export function isKnownMode(mode) {
  return MODES.includes(mode)
}

/**
 * Normalise a user-supplied mode. The bug this fixes: `mode` used to be passed
 * straight into the synthesis prompt and skipped in the cache key, so `mode:
 * 'wat'` silently produced an explain brief under a cache key that ignored mode.
 */
export function normalizeMode(mode, fallback = 'explain') {
  return isKnownMode(mode) ? mode : fallback
}

/* ------------------------------------------------------------------ *
 * Vocabularies, moved here verbatim from their old homes.
 *
 * "Verbatim" is load-bearing: these regexes are the current behaviour, and the
 * tests compare this module against frozen copies of the old definitions.
 * ------------------------------------------------------------------ */

/** Was pipeline.js DEEP_SIGNALS: pushes autoDepth() to `deep`. */
export const DEEP_SIGNALS =
  /对比|选型|调研|方案|迁移|替代|是否值得|取舍|优劣|benchmark|\bvs\.?\b|compare|comparison|migrate|migration|alternatives?|trade-?offs?|which .* should/i

/** Was pipeline.js QUICK_SIGNALS: short questions with these are `quick`. */
export const QUICK_SIGNALS = /是什么|多少|哪一年|谁|定义|what is|who is|how many|when did/i

/** Was pipeline.js LEGAL_HINTS (:702). Primary-law vocabulary. */
export const LEGAL_HINTS =
  /法规|条例|指令|法案|合规|认证|监管|标准原文|regulation|directive|compliance|certification|eur-lex|gdpr|ai act|\bcra\b/i

/** Was util.js TIME_SENSITIVE: freshness matters, so results are not cached. */
export const TIME_SENSITIVE =
  /最新|当前|目前|现在|今年|本月|本周|今天|刚刚|发布|上线|价格|定价|收费|支持到|EOL|过期|停止维护|latest|current|today|this (week|month|year)|release[ds]?|price|pricing|cost|end of life|deprecated/i

/** Was the inline regex in buildQueries(): pick `site:github.com` over `官方`. */
export const CODEISH = /github|npm|pip|library|库|包|api|sdk|报错|error/i

/** Was pipeline.js looksLikeFollowUp(): an elliptical follow-up question. */
export const FOLLOW_UP =
  /(上面|上述|前述|刚才|前面|第\s*[一二三四五六七八九十0-9]+\s*条|展开(说|讲)|这个(方案|结论|说法|观点)|把它|它(指|说|再)|继续(展开|说说)|接上|上一条)/u

/** Was verticals.js BUG_HINTS: a bug report, so GitHub issues are useful. */
export const BUG_HINTS = /\b(bug|issue|error|exception|crash|regression)\b|报错|错误|崩溃|异常|复现/i

/** Was the inline `hn` score regex in verticals.js: an opinion question. */
export const OPINION_HINTS =
  /\b(opinion|discussion|experience|worth|should i|best|alternatives)\b|值得|推荐|体验|看法|对比/i

/** Was verticals.js DEV_HINTS. */
export const DEV_HINTS =
  /\b(node(?:\.js)?|npm|pnpm|yarn|bun|react|vue|svelte|angular|typescript|javascript|python|rust|golang|java|kotlin|swift|c\+\+|api|sdk|library|framework|package|dependency|install|build|compile|error|exception|breaking change|migration)\b|插件|依赖|版本|报错|编译|构建|安装|迁移|接口|框架|库/i

/** Was verticals.js RESEARCH_HINTS. */
export const RESEARCH_HINTS =
  /\b(paper|papers|study|research|benchmark|arxiv|survey|dataset|model|algorithm|论文|研究|实验|评测|基准|算法|数据集)\b|论文|研究|实验|综述/i

/** Was verticals.js PYTHON_HINTS. */
export const PYTHON_HINTS =
  /\bpip install\b|\bpypi\b|python\s+(package|library|module|project)|python\s*(包|库|模块)|虚拟环境|requirements\.txt/i

/** Was verticals.js DOCS_HINTS. */
export const DOCS_HINTS = /\b(react|next|typescript|node|spring|java|python|pandas|numpy)\b/i

/** Was verticals.js MDN_HINTS. */
export const MDN_HINTS = /\b(react|next|typescript|node)\b/i

/** Was verticals.js JAVA_DOCS_HINTS. */
export const JAVA_DOCS_HINTS = /\b(spring|java)\b/i

/** Was verticals.js PYTHON_DOCS_HINTS. */
export const PYTHON_DOCS_HINTS = /\b(python|pandas|numpy)\b/i

/** The single-character "constraint" hint set that autoDepth() counts. */
const CONSTRAINT_CHARS = /[必须需限]/g

/** Disagreement vocabulary (new, folded into the contested kind). */
export const DISPUTE_HINTS =
  /争议|分歧|有人说|质疑|反对|诟病|值不值|是否值得|controversial|debate[ds]?|overrated|underrated|criticism|backlash|split (?:opinions|views)/i

/** Failure vocabulary (new, folded into the troubleshoot kind). */
export const FAILURE_HINTS =
  /无法|失败|超时|不工作|没反应|装了用不了|不生效|闪退|not working|fails? to|broken|hangs?|stuck/i

/** Pasted stack-trace shapes (new, folded into the troubleshoot kind). */
export const STACK_HINTS = /\bat\s+[\w.$]+\s*\([^)]*:\d+\)|Traceback \(most recent call last\)|^\s*Error:/im

/** Learning-intent vocabulary (new, folded into the learning kind). */
export const LEARNING_HINTS =
  /怎么学|如何学|入门|学习路线|从零|零基础|教程|手把手|先学什么|进阶|roadmap|learning path|getting started|tutorial|curriculum|prerequisites/i

/*
 * How each kind earns score. `weight` is the base hit value; `strong` adds a
 * bonus for a single decisive match (a legal citation should beat an incidental
 * comparison). Kept as data so the classifier has no per-kind branches.
 */
const KIND_SIGNALS = {
  'tech-selection': [{ id: 'deep', re: DEEP_SIGNALS, weight: 3 }],
  'fresh-data': [{ id: 'time', re: TIME_SENSITIVE, weight: 3 }],
  contested: [
    { id: 'opinion', re: OPINION_HINTS, weight: 2 },
    { id: 'dispute', re: DISPUTE_HINTS, weight: 3 },
  ],
  legal: [{ id: 'legal', re: LEGAL_HINTS, weight: 3, strong: 3 }],
  troubleshoot: [
    { id: 'bug', re: BUG_HINTS, weight: 3 },
    { id: 'failure', re: FAILURE_HINTS, weight: 2 },
    { id: 'stack', re: STACK_HINTS, weight: 2 },
  ],
  learning: [{ id: 'learning', re: LEARNING_HINTS, weight: 3, strong: 1 }],
  concept: [
    { id: 'quick', re: QUICK_SIGNALS, weight: 2 },
    { id: 'wiki', re: /wiki|百科|定义|原理/i, weight: 1 },
  ],
}

/* ------------------------------------------------------------------ *
 * Mirrors of the old predicates. Same name, same body, one home.
 * ------------------------------------------------------------------ */

/** Mirrors util.js isTimeSensitive() exactly (util re-exports this). */
export function isTimeSensitive(text) {
  return TIME_SENSITIVE.test(String(text ?? ''))
}

/** Mirrors the inline `codeish` test that buildQueries() used per sub-question. */
export function isCodeish(text) {
  return CODEISH.test(String(text ?? ''))
}

/** Mirrors pipeline.js LEGAL_HINTS.test(). */
export function isLegalText(text) {
  return LEGAL_HINTS.test(String(text ?? ''))
}

/** Mirrors pipeline.js looksLikeFollowUp() exactly, including the 80-char cap. */
export function isFollowUp(question) {
  const text = String(question ?? '').trim()
  if (text.length === 0 || text.length > 80) return false
  return FOLLOW_UP.test(text)
}

/**
 * Pricing vocabulary: the question is asking what something costs.
 *
 * Deliberately narrower than TIME_SENSITIVE (which also fires on 发布/release/
 * context words): a freshness question about a release date must not drag the
 * vendor price lists into the run. Only prices, fees and billing wording get
 * PRICING_SEEDS.
 */
export const PRICING_HINTS =
  /价格|定价|售价|收费|计费|费用|费率|多少钱|报价|单价|按量|每百万|百万\s*tokens?|元\/|美元\/|人民币\/|pricing|price[sd]?|cost[sd]?|billing|per (?:million|m) tokens/i

/** True when the question asks for a price, so Step 2b should read the vendor price lists. */
export function isPricingQuestion(text) {
  return PRICING_HINTS.test(String(text ?? ''))
}

function countConstraints(text) {
  return (String(text ?? '').match(CONSTRAINT_CHARS) ?? []).length
}

/**
 * Mirrors pipeline.js autoDepth() exactly, quirks included:
 * - only the question is scanned (focus only matters via its length >= 2);
 * - `text.length < 60` is applied to the raw question, not to question+focus;
 * - a bare "限" (or "需"/"必须" anywhere) counts once each; two of them mean deep.
 */
export function autoDepthOf(question, focus = []) {
  const text = String(question ?? '')
  if (DEEP_SIGNALS.test(text) || focus.length >= 2) return 'deep'
  if (countConstraints(text) >= 2) return 'deep'
  if (text.length < 60 && QUICK_SIGNALS.test(text)) return 'quick'
  return 'standard'
}

/* ------------------------------------------------------------------ *
 * classify: the single implicit judgement.
 * ------------------------------------------------------------------ */

const MAX_SIGNALS = 12
const MAX_KEYWORDS = 8

function unique(list) {
  return [...new Set(list)]
}

function matchKeywords(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const matches = String(text ?? '').match(new RegExp(re.source, flags)) ?? []
  return matches.map((word) => word.trim()).filter(Boolean)
}

function confidenceOf(score) {
  if (score >= 5) return 0.9
  if (score >= 3) return 0.7
  if (score >= 2) return 0.5
  return 0.35
}

function rankScores(scores) {
  return QUESTION_KINDS.map((kind) => ({ kind, score: scores[kind] ?? 0 }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        KIND_PRIORITY.indexOf(left.kind) - KIND_PRIORITY.indexOf(right.kind),
    )
}

/**
 * Classify a question with zero LLM calls.
 *
 * @param {object} input
 * @param {string} [input.question]
 * @param {string[]} [input.focus]
 * @param {Array<string|{q?: string}>} [input.subQuestions] only used for the
 *   code-ish score, never to change the kind (per design §2.0).
 * @param {string} [input.llmKind] an explicit caller override (valid kinds only).
 * @param {string} [input.mode] explicit mode, adds a small intended-use nudge.
 * @returns {{questionKind: string, source: 'regex'|'llm'|'fallback', confidence: number,
 *   scores: Record<string, number>, margin: number, runnerUp: string|null,
 *   signals: string[], keywords: string[], followUp: boolean, timeSensitive: boolean,
 *   codeish: boolean, legalText: boolean, depthHint: 'quick'|'standard'|'deep',
 *   signalVersion: number}}
 */
export function classify({ question = '', focus = [], subQuestions = [], llmKind, mode } = {}) {
  const text = String(question ?? '')
  const focusList = Array.isArray(focus)
    ? focus.map((item) => String(item ?? '')).filter(Boolean)
    : []
  // Legacy predicates ran on "question + focus"; keep that concatenation (the
  // trailing space when focus is empty is irrelevant to every regex here).
  const combined = `${text} ${focusList.join(' ')}`
  const subTexts = Array.isArray(subQuestions)
    ? subQuestions
        .map((sub) => (typeof sub === 'string' ? sub : String(sub?.q ?? '')))
        .filter(Boolean)
    : []

  const scores = {}
  for (const kind of QUESTION_KINDS) scores[kind] = 0
  const signals = []
  const keywords = []
  const addScore = (kind, weight) => {
    scores[kind] += weight
  }

  for (const kind of QUESTION_KINDS) {
    for (const signal of KIND_SIGNALS[kind] ?? []) {
      const matched = matchKeywords(signal.re, combined)
      if (matched.length === 0) continue
      addScore(kind, signal.weight + (signal.strong ?? 0))
      signals.push(`kw:${signal.id}`)
      for (const word of matched) {
        keywords.push(word)
        signals.push(`kw:${word}`)
      }
    }
  }

  // Structural hints. Each one is a legacy rule that is not about wording.
  if (focusList.length >= 2) {
    addScore('tech-selection', 2)
    signals.push('focus:>=2')
  }
  if (countConstraints(text) >= 2) {
    addScore('tech-selection', 1)
    signals.push('constraint:>=2')
  }
  // Sub-questions only feed the code-ish score; they never pick the kind.
  const codeish = isCodeish(combined) || subTexts.some((sub) => isCodeish(sub))
  if (codeish) {
    addScore('tech-selection', 1)
    signals.push('codeish')
  }
  // An explicit mode is the user telling us what they want to do with the answer.
  if (mode === 'compare') {
    addScore('tech-selection', 3)
    signals.push('mode:compare')
  } else if (mode === 'evaluate') {
    addScore('tech-selection', 1)
    addScore('contested', 1)
    signals.push('mode:evaluate')
  } else if (mode === 'track') {
    addScore('fresh-data', 2)
    signals.push('mode:track')
  }

  const ranked = rankScores(scores)
  const best = ranked[0] ?? null
  const runnerUp = ranked[1] ?? null

  let questionKind = 'concept'
  let source = 'fallback'
  let confidence = confidenceOf(0)
  if (best && best.score >= 2) {
    questionKind = best.kind
    source = 'regex'
    confidence = confidenceOf(best.score)
  } else {
    signals.push('fallback:no-signal')
  }

  // Caller override wins, but never invents a vocabulary: unknown kinds are ignored.
  if (isKnownQuestionKind(llmKind)) {
    questionKind = llmKind
    source = 'llm'
    confidence = Math.max(confidence, 0.5)
    signals.push(`llm:${llmKind}`)
  }

  const margin = best ? best.score - (runnerUp?.score ?? 0) : 0

  return {
    questionKind,
    source,
    confidence,
    scores,
    margin,
    runnerUp: runnerUp?.kind ?? null,
    signals: unique(signals).slice(0, MAX_SIGNALS),
    keywords: unique(keywords).slice(0, MAX_KEYWORDS),
    followUp: isFollowUp(text),
    timeSensitive: isTimeSensitive(combined),
    codeish,
    legalText: isLegalText(combined),
    depthHint: autoDepthOf(text, focusList),
    signalVersion: SIGNAL_VERSION,
  }
}

/* ------------------------------------------------------------------ *
 * resolveStrategy: kind + depth + mode -> frozen policy object.
 * ------------------------------------------------------------------ */

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = deepClone(inner)
    return out
  }
  return value
}

function deepMerge(base, extra) {
  const out = deepClone(base)
  if (!isPlainObject(extra)) return out
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value)
    else out[key] = deepClone(value)
  }
  return out
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const inner of Object.values(value)) deepFreeze(inner)
  return value
}

function normalizeRequestedDepth(depth) {
  const value = typeof depth === 'string' ? depth.trim() : ''
  if (value === '' || value === 'auto') return 'auto'
  return DEPTH_ORDER.includes(value) ? value : 'auto'
}

function resolveStrategyMode(mode, pack) {
  if (mode === undefined || mode === null || mode === '') {
    return pack.mode ?? STRATEGY_DEFAULTS.mode
  }
  // Illegal values fall back to explain instead of leaking into the prompt.
  return normalizeMode(mode)
}

function clampDepth(depth, fallback) {
  return DEPTH_ORDER.includes(depth) ? depth : fallback
}

/**
 * Apply the pack's depth bias exactly once, then clamp to [floor, ceiling].
 *
 * `auto` says whether `requested` came from autoDepth(): only then may the bias
 * move it, because an explicit user depth must be honoured. The bias is applied
 * here, on the resolved value — never to DEPTH_PROFILES, and never to the
 * wall-clock ceiling in index.js.
 */
export function applyDepthBias(requested, strategy = null, { auto = false } = {}) {
  const base = clampDepth(requested, 'standard')
  const rawBias = Number(strategy?.depth?.bias ?? 0)
  const bias = auto && Number.isFinite(rawBias) ? rawBias : 0
  const floor = clampDepth(strategy?.depth?.floor, 'quick')
  const ceilingIndex = Math.max(
    DEPTH_ORDER.indexOf(floor),
    DEPTH_ORDER.indexOf(clampDepth(strategy?.depth?.ceiling, 'deep')),
  )
  const moved = DEPTH_ORDER.indexOf(base) + bias
  const bounded = Math.min(DEPTH_ORDER.length - 1, Math.max(0, moved))
  return DEPTH_ORDER[Math.min(ceilingIndex, Math.max(DEPTH_ORDER.indexOf(floor), bounded))]
}

/**
 * Turn a classified kind into a frozen strategy object.
 *
 * Unknown/illegal kinds degrade to `concept` with `reason: 'fallback:unknown-kind'`
 * (design §5); an unknown mode degrades to `explain`. A pricing question also
 * gets `sources.officialSeeds` filled with PRICING_SEEDS; every other question
 * keeps the empty default, so direct-URL fetching is unchanged for it.
 */
export function resolveStrategy({ questionKind = 'concept', depth = 'auto', mode, confidence, reason, question = '' } = {}) {
  const known = isKnownQuestionKind(questionKind)
  const kind = known ? questionKind : 'concept'
  const pack = STRATEGIES[kind] ?? {}
  const strategy = deepMerge(STRATEGY_DEFAULTS, pack)

  strategy.questionKind = kind
  strategy.signalVersion = SIGNAL_VERSION
  strategy.confidence = Number.isFinite(confidence) ? confidence : STRATEGY_DEFAULTS.confidence
  if (reason !== undefined && reason !== null && reason !== '') {
    strategy.reason = String(reason)
  } else if (!known) {
    strategy.reason = 'fallback:unknown-kind'
  } else if (kind === 'concept') {
    strategy.reason = 'fallback:no-signal'
  } else {
    strategy.reason = `kind:${kind}`
  }
  strategy.mode = resolveStrategyMode(mode, pack)
  strategy.depth.requested = normalizeRequestedDepth(depth)
  // Price questions read the vendor price lists by URL (Step 2b), because search
  // rarely surfaces them. Version/release questions stay on the official-domain
  // rule and keep the empty list.
  const seeds = isPricingQuestion(question) ? PRICING_SEEDS : (strategy.sources?.officialSeeds ?? [])
  strategy.sources = { ...(strategy.sources ?? {}), officialSeeds: Object.freeze([...seeds]) }

  return deepFreeze(strategy)
}

/* ------------------------------------------------------------------ *
 * rankBoosts: verticals.prefer -> additive rankHits() boosts.
 * ------------------------------------------------------------------ */

/**
 * Vertical name -> the hosts that vertical actually answers from. Rank hits
 * carry an engine tag only for vertical-API results; the domain list makes the
 * same preference apply to ordinary web results from those hosts.
 */
const VERTICAL_DOMAINS = Object.freeze({
  github: Object.freeze(['github.com']),
  stackexchange: Object.freeze(['stackoverflow.com', 'stackexchange.com']),
  hn: Object.freeze(['news.ycombinator.com']),
  arxiv: Object.freeze(['arxiv.org']),
  scholar: Object.freeze(['scholar.google.com']),
  npm: Object.freeze(['npmjs.com']),
  pypi: Object.freeze(['pypi.org']),
  docs: Object.freeze(['developer.mozilla.org', 'docs.python.org', 'docs.spring.io', 'nodejs.org']),
})

/**
 * Translate a pack's `verticals.prefer` order into the additive `boosts` that
 * rankHits() already understands ({ engines, domains }). The first preferred
 * vertical is nudged hardest, later ones progressively less; nothing is ever
 * hidden or dropped, so an empty/unset prefer returns undefined — the byte-
 * identical legacy ranking.
 */
export function rankBoosts(strategy = null) {
  const prefer = strategy?.verticals?.prefer
  if (!Array.isArray(prefer) || prefer.length === 0) return undefined
  const engines = {}
  const domains = {}
  let picked = 0
  for (const name of prefer) {
    const vertical = typeof name === 'string' ? name.trim().toLowerCase() : ''
    if (!vertical || !VERTICAL_DOMAINS[vertical]) continue
    const weight = Math.max(0.5, 2 - picked * 0.5)
    engines[vertical] = (engines[vertical] ?? 0) + weight
    for (const domain of VERTICAL_DOMAINS[vertical]) domains[domain] = (domains[domain] ?? 0) + weight
    picked += 1
  }
  return picked > 0 ? { engines, domains } : undefined
}
