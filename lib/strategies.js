/**
 * Strategy packs: one plain-data object per questionKind.
 *
 * PR1 ships the data only. `lib/strategy.js` turns a classified kind into a
 * frozen strategy (defaults deep-merged with the pack below), and the pipeline
 * reads `verticals.allow/deny/limit` plus the query shape from it. Every other
 * field is a mirror of today's hard-coded behaviour, so a pack can be adopted
 * stage by stage (PR2) without a flag day.
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
 * `prefer` is the PR2 target order from the design doc. PR1 keeps `allow` empty
 * so vertical selection still goes through the legacy keyword scores unchanged.
 */

/** Bump when signals or packs change shape: cached briefs key on it. */
export const SIGNAL_VERSION = 1

/** All question kinds, in listing order (not priority order). */
export const QUESTION_KINDS = Object.freeze([
  'tech-selection',
  'fresh-data',
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
  'tech-selection',
  'learning',
  'concept',
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
    verticals: Object.freeze({
      prefer: Object.freeze(['github', 'stackexchange', 'hn', 'docs']),
    }),
    synthesis: Object.freeze({ requireConflict: false }),
  }),

  'fresh-data': Object.freeze({
    depth: Object.freeze({ bias: 0 }),
    synthesis: Object.freeze({ dateRule: true }),
    validation: Object.freeze({ staleDays: 365 }),
  }),

  contested: Object.freeze({
    mode: 'explain',
    verticals: Object.freeze({ prefer: Object.freeze(['hn', 'stackexchange']) }),
    synthesis: Object.freeze({ requireConflict: true }),
  }),

  legal: Object.freeze({
    depth: Object.freeze({ bias: 1 }),
    // Unused by PR1 (primaryTargetQueries keeps its legacy branch unless the
    // classifier says the text is legal); recorded for PR2.
    queries: Object.freeze({
      primaryTargets: Object.freeze(['site:eur-lex.europa.eu', 'site:europa.eu']),
    }),
    verticals: Object.freeze({ prefer: Object.freeze([]) }),
    pages: Object.freeze({ reserve: Object.freeze({ vertical: 1, primary: 2 }) }),
    validation: Object.freeze({ requirePrimary: true }),
  }),

  troubleshoot: Object.freeze({
    verticals: Object.freeze({
      prefer: Object.freeze(['stackexchange', 'github', 'docs']),
    }),
    synthesis: Object.freeze({ forumRequired: true }),
  }),

  learning: Object.freeze({
    verticals: Object.freeze({ prefer: Object.freeze(['docs', 'stackexchange', 'hn']) }),
    synthesis: Object.freeze({ stepRequired: true }),
  }),
})

/** True when `kind` names a pack we ship. */
export function isKnownQuestionKind(kind) {
  return QUESTION_KINDS.includes(kind)
}