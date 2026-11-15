// 发布一致性检查：版本号、CHANGELOG 条目、README 预算表与真实 DEPTH_PROFILES 是否一致，
// 以及文档里有没有写死的过时测试数。零依赖，CI 与本地共用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DOCS_WITHOUT_STALE_COUNTS = ['README.md', 'CONTRIBUTING.md'];
const DOCS_DIR = 'docs';

function readFile(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/** 从 lib/pipeline.js 源码里解析 DEPTH_PROFILES（纯函数，便于单测）。 */
export function parseDepthProfiles(source) {
  const match = String(source || '').match(/DEPTH_PROFILES\s*=\s*\{([\s\S]*?)\n\};?/);
  if (!match) return null;
  const profiles = {};
  for (const line of match[1].split('\n')) {
    const row = line.match(/^\s*(\w+)\s*:\s*\{([^}]*)\}/);
    if (!row) continue;
    const profile = {};
    for (const field of row[2].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
      profile[field[1]] = Number(field[2]);
    }
    if (Object.keys(profile).length > 0) profiles[row[1]] = profile;
  }
  return Object.keys(profiles).length > 0 ? profiles : null;
}

/** 从 README 的预算表里解析 depth 行（墙钟单位是秒）。 */
export function parseReadmeBudgets(markdown) {
  const budgets = {};
  for (const line of String(markdown || '').split('\n')) {
    const row = line.match(/^\|\s*(quick|standard|deep)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)s\s*\|/);
    if (!row) continue;
    budgets[row[1]] = {
      queries: Number(row[2]),
      pages: Number(row[3]),
      llmCalls: Number(row[4]),
      gapRounds: Number(row[5]),
      wallMs: Number(row[6]) * 1000,
    };
  }
  return Object.keys(budgets).length > 0 ? budgets : null;
}

/** 把 CHANGELOG 切成 {version, body} 列表（不含 Unreleased），body 是到下一个 `## [` 之前的内容。 */
export function releaseSections(markdown) {
  const text = String(markdown || '');
  const sections = [];
  const heading = /^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm;
  const matches = [...text.matchAll(heading)];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections.push({ version: matches[index][1], body: text.slice(start, end).trim() });
  }
  return sections;
}

/** 找出文档里写死的测试例数（如「352 例」），这种数字每加一个测试就会过期。 */
export function staleTestCounts(text) {
  const hits = [];
  for (const match of String(text || '').matchAll(/(\d{2,4})\s*例/g)) {
    hits.push({ count: Number(match[1]), snippet: match[0] });
  }
  return hits;
}

/** 本地 tag 名（读 .git/refs/tags 与 .git/packed-refs，不调用 git 进程）。 */
export function localTags(root = DEFAULT_ROOT) {
  const names = new Set();
  const dir = path.join(root, '.git', 'refs', 'tags');
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath ?? dir, entry.name);
      names.add(path.relative(dir, full).split(path.sep).join('/'));
    }
  } catch {
    /* 没有 refs 目录时忽略 */
  }
  const packed = readFile(root, '.git/packed-refs');
  if (packed) {
    for (const line of packed.split('\n')) {
      const match = line.match(/^[0-9a-f]{40}\s+refs\/tags\/(.+)$/);
      if (match) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function compareBudgets(actual, documented, failures) {
  for (const depth of ['quick', 'standard', 'deep']) {
    const real = actual?.[depth];
    const doc = documented?.[depth];
    if (!real || !doc) {
      failures.push(`预算表缺少 ${depth}：README 里要有一行，lib/pipeline.js 里要有对应 profile`);
      continue;
    }
    for (const field of ['queries', 'pages', 'llmCalls', 'gapRounds', 'wallMs']) {
      if (real[field] !== doc[field]) {
        failures.push(
          `预算不一致（${depth}.${field}）：代码 ${real[field]}，README ${doc[field]}` +
            (field === 'wallMs' ? `（${real[field] / 1000}s vs ${doc[field] / 1000}s）` : '')
        );
      }
    }
  }
}

/** 返回 { passes, failures, notes }，failures 非空时 CLI 以非零码退出。 */
export function checkRelease(root = DEFAULT_ROOT) {
  const passes = [];
  const failures = [];
  const notes = [];

  const pkgRaw = readFile(root, 'package.json');
  let pkg = null;
  try {
    pkg = pkgRaw ? JSON.parse(pkgRaw) : null;
  } catch {
    failures.push('package.json 不是合法 JSON');
  }
  const version = pkg?.version ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    failures.push(`package.json 版本不是 x.y.z：${JSON.stringify(version)}`);
  } else {
    passes.push(`版本号 ${version}`);
  }

  const changelog = readFile(root, 'CHANGELOG.md') ?? '';
  if (!/^## \[Unreleased\]/m.test(changelog)) failures.push('CHANGELOG.md 缺少「## [Unreleased]」小节');
  else passes.push('CHANGELOG 有 Unreleased 小节');
  if (version && !changelog.includes(`## [${version}]`)) {
    failures.push(`CHANGELOG.md 没有当前版本小节「## [${version}]」`);
  } else if (version) {
    passes.push(`CHANGELOG 有 [${version}] 小节`);
  }

  const sectionVersions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const sorted = [...sectionVersions].sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
  if (sectionVersions.join(',') !== sorted.join(',')) {
    failures.push('CHANGELOG 版本小节不是从新到旧排列');
  } else if (sectionVersions.length > 0) {
    passes.push(`CHANGELOG 版本小节按新到旧排列（${sectionVersions.length} 条）`);
  }

  const sections = releaseSections(changelog);
  const duplicated = [...new Set(sectionVersions.filter((v, i) => sectionVersions.indexOf(v) !== i))];
  if (duplicated.length) failures.push(`CHANGELOG 有重复的版本小节：${duplicated.join('、')}`);
  const emptySections = sections.filter((section) => !section.body).map((section) => section.version);
  if (emptySections.length) {
    failures.push(`CHANGELOG 里这些版本小节是空的（发 Release 时正文会为空）：${emptySections.join('、')}`);
  } else if (sections.length) {
    passes.push(`CHANGELOG 每个版本小节都有正文（${sections.length} 个）`);
  }

  const profiles = parseDepthProfiles(readFile(root, 'lib/pipeline.js') ?? '');
  const readme = readFile(root, 'README.md') ?? '';
  const budgets = parseReadmeBudgets(readme);
  if (!profiles) failures.push('lib/pipeline.js 里找不到 DEPTH_PROFILES');
  if (!budgets) failures.push('README.md 里找不到预算表（quick/standard/deep 三行）');
  if (profiles && budgets) {
    const before = failures.length;
    compareBudgets(profiles, budgets, failures);
    if (failures.length === before) passes.push('README 预算表与 DEPTH_PROFILES 一致');
  }

  for (const doc of DOCS_WITHOUT_STALE_COUNTS) {
    const text = readFile(root, doc);
    if (text === null) continue;
    const hits = staleTestCounts(text);
    if (hits.length > 0) {
      failures.push(`${doc} 写死了测试例数（${hits.map((h) => h.snippet).join(' / ')}），删掉数字改成描述`);
    }
  }
  const docsDir = path.join(root, DOCS_DIR);
  try {
    for (const name of fs.readdirSync(docsDir)) {
      if (!name.endsWith('.md')) continue;
      const hits = staleTestCounts(readFile(root, path.join(DOCS_DIR, name)) ?? '');
      if (hits.length > 0) {
        failures.push(`${DOCS_DIR}/${name} 写死了测试例数（${hits.map((h) => h.snippet).join(' / ')}），删掉数字改成描述`);
      }
    }
  } catch {
    /* 没有 docs 目录时忽略 */
  }
  passes.push('README/docs/CONTRIBUTING 没有写死测试例数');

  const tags = localTags(root);
  if (version && tags.includes(`v${version}`)) {
    passes.push(`本地已有 tag v${version}`);
  } else if (version) {
    notes.push(`本地还没有 tag v${version}（发布后补：git tag -a v${version} -m …）`);
  }

  return { passes, failures, notes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { passes, failures, notes } = checkRelease();
  for (const line of passes) console.log(`✔ ${line}`);
  for (const line of notes) console.log(`· ${line}`);
  for (const line of failures) console.log(`✘ ${line}`);
  if (failures.length > 0) {
    console.error(`\n✘ 发布一致性检查失败：${failures.length} 项`);
    process.exit(1);
  }
  console.log('\n✔ 发布一致性检查通过');
}