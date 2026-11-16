/**
 * Strategy packs: one plain-data object per questionKind.
 *
 * PR2 wires the data in. `lib/strategy.js` turns a classified kind into a frozen
 * strategy (defaults deep-merged with the pack below), and the pipeline reads
 * `verticals.allow/deny/limit`, the query plan, the declared brief sections, the
 * confidence gates and the preferred-source ranking from it. Every default field
 * still mirrors today's hard-coded behaviour, so a pack is adopted stage by
 * stage without a flag day and the concept pack reproduces PR1 byte for byte.
 *
 * Values mirror the existing constants exactly:
 *   depth      -> DEPTH_PROFILES (lib/pipeline.js) semantics
 *   queries    -> buildQueries() (lib/pipeline.js)
 *   verticals  -> pickVerticals() (lib/verticals.js)
 *   pages      -> runResearch() page budget / reserve logic
 *   evidence   -> toEvidence(), isGrounded(), heuristicEvidence()
 *   synthesis  -> brief section requirements
 *   validation -> primary-source / staleness gates
 *   gates      -> confidence gating (design doc calls this key `confidence`)
 *
 * `prefer` is the PR2 target order from the design doc: it only feeds the
 * additive ranking boosts (lib/strategy.js rankBoosts), never vertical
 * selection, so an empty list keeps the legacy order exactly.
 */

/** Bump when signals or packs change shape: cached briefs key on it. */
export const SIGNAL_VERSION = 4

/** All question kinds, in listing order (not priority order). */
export const QUESTION_KINDS = Object.freeze([
  'tech-selection',
  'fresh-data',
  // 0.8.3 — "what does it cost / which is cheaper" is its own kind. Before it,
  // the stack word in "qwen、豆包、deepseek 哪家便宜" won the classification and
  // the run crawled Java manuals for a question about money.
  'pricing',
  // 0.10.0 — a judgement question ("该不该 / 要不要 / 值不值得") is its own kind.
  // Before it, C 题「我们团队 8 个人，微服务该不该拆」scored 0 on every kind and
  // fell back to concept; the cost columns came from a wording patch in prompts.js.
  'decision',
  'contested',
  'legal',
  'troubleshoot',
  'learning',
  'concept',
])

/**
 * Tie-break order for equally strong kinds: a legal question that also reads
 * like a comparison should stay legal. Concept is always last.
 */
export const KIND_PRIORITY = Object.freeze([
  'legal',
  'troubleshoot',
  'contested',
  'fresh-data',
  'pricing',
  // 0.10.0 — a price question wins over a decision one ("该不该买，多少钱" is a
  // pricing question: the vendor price page decides it). Below pricing and above
  // tech-selection: a yes/no adoption ask ("该不该用 React") is a decision, not a
  // head-to-head selection; the reverse mix ("React 还是 Vue 该选哪个") carries no
  // decision wording, so tech-selection is unmoved by this ordering.
  'decision',
  'tech-selection',
  'learning',
  'concept',
])

/**
 * Direct-fetch seeds for pricing questions: the vendor price lists themselves.
 *
 * Search cannot surface these reliably (they are login-free doc pages that rank
 * below blog posts), and a price question answered without the current price
 * page is the regression this list exists for. The pipeline fetches the first
 * two of them in Step 2b, after any URL the user pasted. Version/release
 * questions are covered by the existing official-domain rules, so they get no
 * seeds (their `sources.officialSeeds` stays empty).
 */
export const PRICING_SEEDS = Object.freeze([
  'https://api-docs.deepseek.com/quick_start/pricing',
  'https://help.aliyun.com/zh/model-studio/models',
  'https://bigmodel.cn/pricing',
  'https://www.volcengine.com/docs/82379/1099320',
])

/**
 * The concept strategy == today's behaviour, field for field. Every other pack
 * is a diff against this object, which makes the concept golden anchor in the
 * tests meaningful: an unclassified or unknown question is exactly as before.
 */
export const STRATEGY_DEFAULTS = Object.freeze({
  questionKind: 'concept',
  signalVersion: SIGNAL_VERSION,
  confidence: 0.35,
  reason: 'fallback:no-signal',
  mode: 'explain',
  depth: Object.freeze({
    requested: 'auto',
    bias: 0,
    floor: 'quick',
    ceiling: 'deep',
  }),
  queries: Object.freeze({
    siteTargets: Object.freeze([]),
    primaryTargets: Object.freeze([]),
    perSubVariants: Object.freeze(['sub', 'sub+focus', 'site|official']),
    latinBoost: true,
    maxLen: 100,
    // null = decide per sub-question with the shared code-ish regex.
    codeish: null,
    // Kind-directed queries appended ahead of the generic variants. Placeholders:
    // {q} is the compact question, {year} the current year. Empty = old behaviour.
    extraTemplates: Object.freeze([]),
    // `site:` hints prefixed to the compact question (legal → EUR-Lex).
    siteHints: Object.freeze([]),
    // Per-kind cap on the deterministic plan; null = the caller's limit.
    limit: null,
  }),
  verticals: Object.freeze({
    allow: Object.freeze([]),
    prefer: Object.freeze([]),
    deny: Object.freeze([]),
    limit: 2,
  }),
  pages: Object.freeze({
    reserve: Object.freeze({ vertical: 1, primary: 2 }),
    refillReserve: 2,
    officialHop: true,
    refillMax: 4,
  }),
  // Official pages fetched by URL before search runs (Step 2b). Empty by
  // default: only a pricing question gets PRICING_SEEDS (resolveStrategy fills
  // them), so every other kind keeps the legacy direct-URL behaviour exactly.
  sources: Object.freeze({
    officialSeeds: Object.freeze([]),
  }),
  // 0.6.0: declared source-fetch plan for this kind. Empty channels keeps the
  // legacy fetch set exactly (the 237-test baseline protects that). `method`
  // is sitemap | direct | api; only sitemap is dispatched today (Step 2a).
  sourcePlan: Object.freeze({
    channels: Object.freeze([]),
    // Browser rendering (Jina) is opt-in per kind and capped; docs kinds allow
    // one call, every other kind inherits this off.
    renderFallback: Object.freeze({ allowed: false, maxCalls: 0 }),
  }),
  evidence: Object.freeze({
    heuristicFallback: true,
    fallbackLog: true,
    maxPerPage: 6,
    types: Object.freeze(['official', 'docs', 'repo', 'paper', 'forum', 'blog', 'news']),
    groundMinChars: 12,
  }),
  synthesis: Object.freeze({
    sections: null,
    requireConflict: false,
    dateRule: false,
    forumRequired: false,
    stepRequired: true,
  }),
  // Sections the brief must carry for this kind; null = the four legacy ones
  // only. A missing declared section is filled with its fallback and costs one
  // confidence notch (see computeConfidence's `missingSections` gate).
  brief: Object.freeze({
    requiredSections: null,
  }),
  validation: Object.freeze({
    requirePrimary: false,
    minSources: 1,
    staleDays: 730,
  }),
  gates: Object.freeze({
    gate: 'high',
    requirePrimaryForHigh: true,
    minPrimaryDomains: 2,
    primaryMissingCap: 'low',
  }),
})

/**
 * Per-kind diffs over STRATEGY_DEFAULTS. Only the differences the design doc
 * calls for (§2), so the table stays auditable against it. Anything not listed
 * here is inherited unchanged from the concept anchor.
 */
export const STRATEGIES = Object.freeze({
  // The golden anchor: no diff at all.
  concept: Object.freeze({}),

  'tech-selection': Object.freeze({
    mode: 'compare',
    depth: Object.freeze({ bias: 1 }),
    queries: Object.freeze({
      extraTemplates: Object.freeze(['{q} vs alternatives', '{q} alternatives', '{q} benchmark']),
    }),
    verticals: Object.freeze({
      prefer: Object.freeze(['github', 'stackexchange', 'hn', 'docs']),
    }),
    // Official documentation is the primary source for a technology choice;
    // a sitemap crawl picks the exact versioned doc pages. Jina is allowed once
    // for documentation hosts whose pages ship as JS shells.
    sourcePlan: Object.freeze({
      channels: Object.freeze([
        Object.freeze({
          id: 'official-docs',
          method: 'sitemap',
          hosts: Object.freeze(['docs.spring.io', 'spring.io', 'langchain4j.dev', 'nodejs.org', 'docs.python.org', 'developer.mozilla.org']),
          // 0.6.3: site roots tried in order until one answers. 0.6.8: each
          // candidate carries tags describing the stack it documents, and
          // `pickDocBases` orders them by how well the tags match the question
          // (untagged entries are the generic fallback). Spring Boot's sitemap
          // lives at `docs.spring.io/spring-boot/sitemap.xml`, Spring AI's at
          // `docs.spring.io/spring-ai/reference/sitemap.xml`; picking the wrong
          // sibling returns docs for another project.
          bases: Object.freeze([
            Object.freeze({
              base: 'https://docs.spring.io/spring-ai/reference/',
              tags: Object.freeze(['spring-ai', 'ai', 'rag', 'vector']),
            }),
            Object.freeze({
              base: 'https://docs.spring.io/spring-boot',
              tags: Object.freeze(['spring-boot', 'boot', 'web', 'jpa']),
            }),
            Object.freeze({
              base: 'https://docs.langchain4j.dev/',
              tags: Object.freeze(['langchain4j', 'llm', 'rag', 'agent']),
            }),
            // Generic fallback: kept last, only tried when no tag matches.
            Object.freeze({ base: 'https://docs.spring.io', tags: Object.freeze([]) }),
          ]),
          maxPages: 3,
        }),
      ]),
      renderFallback: Object.freeze({ allowed: true, maxCalls: 1 }),
    }),
    synthesis: Object.freeze({ requireConflict: false }),
    brief: Object.freeze({ requiredSections: Object.freeze(['## 方案对比', '## 坑与风险']) }),
    // 1.1.2 — this pack used to cap every comparison at "medium" ("a comparison
    // without a head-to-head table is not a verdict yet"). The concern is now
    // measured instead of assumed: a comparison that leaves an option without
    // evidence is capped by computeConfidence's `zeroEvidence` gate, and a
    // declared section filled with a placeholder still costs a notch. The blanket
    // cap only made "high" unreachable for a comparison whose every row was
    // first-party — the 1.1.1 eval reported `low` for a 90%-official, 8-source
    // RAG answer because of it.
  }),

  'fresh-data': Object.freeze({
    depth: Object.freeze({ bias: 0 }),
    queries: Object.freeze({
      extraTemplates: Object.freeze(['{q} pricing {year}', '{q} 价格 {year}', '{q} release notes']),
    }),
    // Pricing pages are stable enough to fetch directly once the seeds are known.
    sourcePlan: Object.freeze({
      channels: Object.freeze([
        Object.freeze({
          id: 'pricing',
          method: 'direct',
          hosts: Object.freeze(['api-docs.deepseek.com', 'help.aliyun.com', 'bigmodel.cn', 'www.volcengine.com']),
          // 0.6.3: the channel now owns its seeds instead of relying on the
          // legacy two-seed path, so every declared vendor price list is tried
          // (the page budget still has the last word). All four URLs returned
          // HTTP 200 when this list was wired.
          seeds: PRICING_SEEDS,
          maxPages: 4,
        }),
      ]),
    }),
    synthesis: Object.freeze({ dateRule: true }),
    validation: Object.freeze({ staleDays: 365 }),
    brief: Object.freeze({ requiredSections: Object.freeze(['## 依据', '## 置信度']) }),
    // Undated or stale evidence cannot support a "high" freshness answer.
    gates: Object.freeze({ gate: 'medium' }),
  }),

  // 0.8.3 — price/cost questions. The pack exists so classify() can *name* the
  // kind: before it, a price question either fell into tech-selection (the stack
  // word won) or fresh-data, and the tech-selection pack then crawled
  // docs.spring.io / docs.langchain4j.dev for a question about money. Price
  // lists are the primary source, fetched directly; nothing here ever points at
  // a technology stack's documentation site.
  pricing: Object.freeze({
    depth: Object.freeze({ bias: 0 }),
    queries: Object.freeze({
      extraTemplates: Object.freeze(['{q} 价格对比 {year}', '{q} api pricing per token']),
    }),
    // Same verified vendor price lists as the fresh-data channel, but declared
    // here so the *kind* owns them: resolveStrategy() also forces this channel
    // onto any price question whose kind other signals pushed elsewhere.
    sourcePlan: Object.freeze({
      channels: Object.freeze([
        Object.freeze({
          id: 'pricing',
          method: 'direct',
          hosts: Object.freeze(['api-docs.deepseek.com', 'help.aliyun.com', 'bigmodel.cn', 'www.volcengine.com']),
          seeds: PRICING_SEEDS,
          maxPages: 4,
        }),
      ]),
    }),
    synthesis: Object.freeze({ dateRule: true }),
    validation: Object.freeze({ staleDays: 365 }),
    // 1.1.2 — a blanket "medium" cap used to sit here ("prices are dated facts:
    // undated or stale evidence cannot support high"). It punished exactly the
    // price lists that *were* current vendor pages: the 1.1.1 eval saw a
    // 100%-official, 8-source price answer capped below what its evidence
    // supports. Staleness is still handled — stale cards are dropped before the
    // verdict and the date rule marks undated rows — but it is a fact about one
    // source, not a ceiling for the whole brief.
  }),

  // 0.10.0 — judgement questions: 该不该 / 要不要 / 值不值得. The answer is a
  // verdict plus the thresholds behind it, so the evidence that matters is the
  // team's own numbers (headcount, release cadence, MTTR) and the published
  // counter-examples — not an official docs page. Hence no source channel at all:
  // an empty `channels` is a declaration ("nothing to fetch directly"), not an
  // omission, and it keeps the kind off the official-docs crawl.
  decision: Object.freeze({
    // Same depth as concept: a decision brief gains nothing from a deeper crawl,
    // it gains from quantified criteria — those come from the question, not pages.
    depth: Object.freeze({ bias: 0 }),
    queries: Object.freeze({
      extraTemplates: Object.freeze([
        '{q} 何时该拆 微服务',
        '{q} 团队规模 阈值',
        '{q} 反例 失败',
        '{q} trade-offs',
      ]),
    }),
    sourcePlan: Object.freeze({ channels: Object.freeze([]) }),
    // No brief.requiredSections here: `## 判据` is an answer-layer contract
    // (lib/brief.js DECISION_CRITERIA_HEADING), the same way `## 行动清单` is, so
    // it must hold even when a caller overrides the strategy. Declaring it in both
    // places would make requiredSectionsFor() dedupe two owners of one section.
  }),

  contested: Object.freeze({
    mode: 'explain',
    queries: Object.freeze({
      extraTemplates: Object.freeze(['{q} criticism', '{q} 争议 反对']),
    }),
    verticals: Object.freeze({ prefer: Object.freeze(['hn', 'stackexchange']) }),
    // Both sides of a contested claim live in papers, not on vendor pages.
    sourcePlan: Object.freeze({
      channels: Object.freeze([
        Object.freeze({
          id: 'papers',
          method: 'api',
          hosts: Object.freeze(['arxiv.org', 'openalex.org', 'pmc.ncbi.nlm.nih.gov']),
          maxPages: 2,
        }),
      ]),
    }),
    synthesis: Object.freeze({ requireConflict: true }),
    brief: Object.freeze({ requiredSections: Object.freeze(['## 存在冲突', '## 坑与风险']) }),
    gates: Object.freeze({ gate: 'medium' }),
  }),

  legal: Object.freeze({
    depth: Object.freeze({ bias: 1 }),
    // The legal text itself is the only primary source that counts, so the
    // queries already point at the official publications.
    queries: Object.freeze({
      primaryTargets: Object.freeze(['site:eur-lex.europa.eu', 'site:europa.eu']),
      siteHints: Object.freeze(['site:eur-lex.europa.eu', 'site:europa.eu']),
    }),
    verticals: Object.freeze({ prefer: Object.freeze([]) }),
    // Standards bodies and legal texts: direct fetches, no sitemap crawl.
    sourcePlan: Object.freeze({
      channels: Object.freeze([
        Object.freeze({
          id: 'standards',
          method: 'direct',
          hosts: Object.freeze(['prisma-statement.org', 'cochrane.org', 'eric.ed.gov', 'owasp.org', 'eur-lex.europa.eu']),
          maxPages: 2,
        }),
      ]),
    }),
    pages: Object.freeze({ reserve: Object.freeze({ vertical: 1, primary: 2 }) }),
    validation: Object.freeze({ requirePrimary: true }),
    brief: Object.freeze({ requiredSections: Object.freeze(['## 依据', '## 未解决']) }),
  }),

  troubleshoot: Object.freeze({
    queries: Object.freeze({
      extraTemplates: Object.freeze(['{q} 解决', '{q} stack trace']),
    }),
    verticals: Object.freeze({
      prefer: Object.freeze(['stackexchange', 'github', 'docs']),
    }),
    synthesis: Object.freeze({ forumRequired: true }),
    brief: Object.freeze({ requiredSections: Object.freeze(['## 结论', '## 下一步建议']) }),
    gates: Object.freeze({ gate: 'medium' }),
  }),

  learning: Object.freeze({
    queries: Object.freeze({
      extraTemplates: Object.freeze(['{q} roadmap', '{q} 入门 教程']),
    }),
    verticals: Object.freeze({ prefer: Object.freeze(['docs', 'stackexchange', 'hn']) }),
    // Learning paths start at official documentation; Jina is allowed once for
    // JS-shelled tutorial sites (same gate as tech-selection).
    sourcePlan: Object.freeze({
      channels: Object.freeze([
        Object.freeze({
          id: 'official-docs',
          method: 'sitemap',
          hosts: Object.freeze(['docs.spring.io', 'spring.io', 'langchain4j.dev', 'nodejs.org', 'docs.python.org', 'developer.mozilla.org']),
          // Learning starts at tutorial sites; react.dev publishes no sitemap, so
          // nodejs.org / docs.python.org are the fallbacks behind it (0.6.3).
          bases: Object.freeze(['https://react.dev', 'https://nodejs.org', 'https://docs.python.org']),
          maxPages: 3,
        }),
      ]),
      renderFallback: Object.freeze({ allowed: true, maxCalls: 1 }),
    }),
    synthesis: Object.freeze({ stepRequired: true }),
    brief: Object.freeze({ requiredSections: Object.freeze(['## 依据', '## 下一步建议']) }),
    gates: Object.freeze({ gate: 'medium' }),
  }),
})

/** True when `kind` names a pack we ship. */
export function isKnownQuestionKind(kind) {
  return QUESTION_KINDS.includes(kind)
}