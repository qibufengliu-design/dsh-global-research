// Client half of @local/dsh-global-research: renders a compact card for the
// `research` tool call instead of the generic tool row. The host half always
// returns plain Markdown, so this file only reads block.content[0].text and
// never talks to the network.
//
// Everything lives inside the factory: the boot script composes this file into
// one combo bundle with other plugins, so top-level const declarations would
// risk a SyntaxError collision in that shared script scope.

window.__ModuleLoader__.load({
  id: '@local/dsh-global-research',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CONFIDENCE = {
      high: { label: '高置信度', color: '#2f9e6e', bg: 'rgba(47,158,110,.12)' },
      medium: { label: '中置信度', color: '#b9811f', bg: 'rgba(185,129,31,.12)' },
      low: { label: '低置信度', color: '#c0504d', bg: 'rgba(192,80,77,.12)' },
    }

    const BORDER = '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))'
    const CAPTION = 'var(--dsw-alias-label-caption, #8a8a8a)'
    const MONO = 'var(--dsw-font-markdown-code-block-small, 12px/1.5 ui-monospace, monospace)'
    const BRAND = 'var(--dsw-alias-brand, #4f7cff)'
    const RED = '#c0504d'
    const GREEN = '#2f9e6e'

    // `styles` is an optional host builtin (older builds expose it, some do
    // not), so the spinner keyframes are also installable through a plain
    // <style> tag. Both paths are best-effort: cosmetics must never throw.
    const SPIN_CSS = [
      '@keyframes gr-card-spin{to{transform:rotate(360deg)}}',
      '.gr-card-spin{display:inline-block;width:10px;height:10px;border-radius:999px;',
      'border:1.5px solid currentColor;border-top-color:transparent;',
      'animation:gr-card-spin .8s linear infinite}',
    ].join('')
    const SPIN_CLASS = 'gr-card-spin'
    let spinStylesInstalled = false

    function ensureSpinStyles() {
      if (spinStylesInstalled) return
      spinStylesInstalled = true
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          styles.insert(SPIN_CSS)
          return
        }
        if (typeof document === 'undefined' || !document || !document.head) return
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-global-research', '')
        tag.textContent = SPIN_CSS
        document.head.appendChild(tag)
      } catch (error) {
        // A missing spinner must not break the card.
      }
    }

    function textOf(block) {
      if (!block || !Array.isArray(block.content)) return ''
      return block.content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }

    function section(text, title) {
      const marker = `## ${title}`
      const start = text.indexOf(marker)
      if (start < 0) return ''
      const body = text.slice(start + marker.length)
      const next = body.search(/^## /m)
      return (next < 0 ? body : body.slice(0, next)).trim()
    }

    function confidenceOf(text) {
      const block = section(text, '置信度')
      const match = /\*\*\s*(high|medium|low)\s*\*\*/i.exec(block)
      if (match) return match[1].toLowerCase()
      if (/\*\*\s*高/.test(block)) return 'high'
      if (/\*\*\s*中/.test(block)) return 'medium'
      if (/\*\*\s*低/.test(block)) return 'low'
      return undefined
    }

    function sourceCount(text) {
      const refs = section(text, '参考')
      const numbered = refs.match(/^-\s*\[S\d+\]/gm)
      if (numbered) return numbered.length
      const ids = new Set()
      const all = /\[S(\d+)\]/g
      let hit
      while ((hit = all.exec(text))) ids.add(hit[1])
      return ids.size
    }

    function domainOf(url) {
      const match = /^https?:\/\/([^/?#\s]+)/i.exec(url || '')
      if (!match) return ''
      return match[1].replace(/^www\./i, '').toLowerCase()
    }

    /**
     * Pull `- [S1] 标签 — https://…` rows out of the 参考 section. The brief is
     * plain Markdown, so this is the only structured thing the card can mine;
     * lines that carry no URL are dropped rather than rendered as dead links.
     */
    function parseSources(text) {
      const block = section(text, '参考')
      if (!block) return []
      const out = []
      const seen = new Set()
      block.split(/\r?\n/).forEach((line) => {
        const match = /^\s*[-*]\s*\[S(\d+)\]\s*(.+)$/.exec(line)
        if (!match) return
        const id = `S${match[1]}`
        if (seen.has(id)) return
        const body = match[2].trim()
        const urlMatch = /https?:\/\/[^\s)>」]+/i.exec(body)
        if (!urlMatch) return
        const url = urlMatch[0].replace(/[.,;:]+$/, '')
        const label = body.replace(/https?:\/\/\S+/gi, '').replace(/[—–-]\s*$/, '').trim()
        seen.add(id)
        out.push({ id, url, label, domain: domainOf(url) })
      })
      return out
    }

    function isErrorBlock(block) {
      if (!block) return false
      if (block.isError === true || block.error) return true
      return [
        block.result,
        block.response && block.response.result,
        block.call && block.call.result,
      ].some((candidate) => candidate && (candidate.isError === true || candidate.error))
    }

    /** The failure text the host left in the block, trimmed to a preview size. */
    function errorTextOf(block) {
      if (!block) return ''
      const source = block.error || textOf(block) ||
        (block.result && block.result.error) ||
        (block.call && block.call.result && block.call.result.error) || ''
      const raw = typeof source === 'string' ? source : String((source && source.message) || source)
      return raw.trim()
    }

    function plain(markdown) {
      return markdown
        .replace(/\[S\d+\]/g, '')
        .replace(/〔来源未列出〕/g, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/^>\s?/gm, '')
        .replace(/^\s*[-*]\s+/gm, '· ')
        .replace(/\n{2,}/g, '\n')
        .trim()
    }

    function elapsedOf(block) {
      if (block && block.meta && typeof block.meta.elapsedMs === 'number') {
        return Math.max(1, Math.round(block.meta.elapsedMs / 1000))
      }
      return undefined
    }

    // The host appends a fixed `> 本次检索：…` line after 参考. Briefs rendered
    // before this feature (or older cached results) have none: show no row then.
    function runStatsOf(text) {
      const match = /^>\s*本次检索：\s*(\d+)\s*个查询\s*·\s*(\d+)\s*个页面\s*·\s*(\d+)\s*条证据\s*·\s*(\d+)\s*秒(?:（([^）]*)）)?/m.exec(text)
      if (!match) return undefined
      const stats = {
        queries: Number(match[1]),
        pages: Number(match[2]),
        evidence: Number(match[3]),
        seconds: Number(match[4]),
      }
      if (!stats.queries && !stats.pages && !stats.evidence) return undefined
      return stats
    }

    // The stats line may end with `· 阶段 拆题1s/检索12s/精读30s/合成25s`. Old
    // briefs and quick runs without slow stages have no such segment: no row.
    function stageChipsOf(text) {
      const match = /^>\s*本次检索：.*?·\s*阶段\s+([^\n·]+)/m.exec(text)
      if (!match) return undefined
      const chips = match[1].split('/').map((part) => part.trim()).filter(Boolean).slice(0, 4)
      return chips.length > 0 ? chips : undefined
    }

    /**
     * Older shells (and non-secure origins) have no navigator.clipboard, so a
     * hidden textarea + execCommand stays as the fallback. Returns true when
     * the text actually reached the clipboard.
     */
    function legacyCopy(text) {
      try {
        if (typeof document === 'undefined' || !document) return false
        if (typeof document.createElement !== 'function') return false
        const area = document.createElement('textarea')
        if (!area) return false
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        if (document.body && typeof document.body.appendChild === 'function') {
          document.body.appendChild(area)
        }
        if (typeof area.select === 'function') area.select()
        const ok = typeof document.execCommand === 'function'
          ? Boolean(document.execCommand('copy'))
          : false
        if (area.parentNode && typeof area.parentNode.removeChild === 'function') {
          area.parentNode.removeChild(area)
        }
        return ok
      } catch (error) {
        return false
      }
    }

    function copyText(text) {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined
      const clipboard = nav && nav.clipboard
      if (clipboard && typeof clipboard.writeText === 'function') {
        try {
          const pending = clipboard.writeText(text)
          if (pending && typeof pending.then === 'function') {
            return pending.then(() => true, () => legacyCopy(text))
          }
          return Promise.resolve(true)
        } catch (error) {
          return Promise.resolve(legacyCopy(text))
        }
      }
      return Promise.resolve(legacyCopy(text))
    }

    function Header(props) {
      const clickable = typeof props.onToggle === 'function'
      return h('div', {
        role: clickable ? 'button' : undefined,
        tabIndex: clickable ? 0 : undefined,
        onClick: clickable ? props.onToggle : undefined,
        onKeyDown: clickable
          ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              props.onToggle()
            }
          }
          : undefined,
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          font: MONO, color: CAPTION,
          cursor: clickable ? 'pointer' : undefined,
          userSelect: 'none',
        },
      },
      h('span', {
        'aria-hidden': true,
        style: {
          width: 6, height: 6, borderRadius: 999, display: 'inline-block',
          background: props.badge ? props.badge.color : CAPTION,
        },
      }),
      h('span', { style: { fontWeight: 600, color: 'inherit' } }, '全球研究'),
      props.badge ? h('span', {
        style: {
          padding: '1px 7px', borderRadius: 999, color: props.badge.color,
          background: props.badge.bg, fontWeight: 600,
        },
      }, props.badge.label) : null,
      props.meta ? h('span', null, props.meta) : null,
      h('span', { style: { flex: 1 } }),
      props.copyLabel
        ? h('button', {
          key: 'copy',
          type: 'button',
          title: '复制完整简报 Markdown',
          'aria-label': '复制完整简报',
          onClick: (event) => {
            event.stopPropagation()
            if (typeof props.onCopy === 'function') props.onCopy()
          },
          style: {
            border: 'none', background: 'transparent', cursor: 'pointer',
            padding: 0, font: 'inherit', whiteSpace: 'nowrap',
            color: props.copyState === 'copied' ? GREEN
              : props.copyState === 'failed' ? RED : CAPTION,
          },
        }, props.copyLabel)
        : null,
      props.toggleLabel
        ? h('button', {
          key: 'toggle',
          type: 'button',
          onClick: (event) => {
            event.stopPropagation()
            props.onToggle()
          },
          style: {
            border: 'none', background: 'transparent', color: CAPTION,
            cursor: 'pointer', padding: 0, font: 'inherit',
          },
        }, props.toggleLabel)
        : null)
    }

    function frame(children) {
      return h('div', {
        style: {
          border: BORDER, borderRadius: 'var(--dsw-radius-lg, 10px)',
          padding: '10px 12px', margin: '4px 0 4px 4px',
          display: 'flex', flexDirection: 'column', gap: 6,
          background: 'var(--dsw-alias-markdown-code-block, transparent)',
          font: MONO,
        },
      }, children)
    }

    function ResearchCard(props) {
      const block = props.block
      const [open, setOpen] = React.useState(false)
      const [sourcesOpen, setSourcesOpen] = React.useState(false)
      const [copyState, setCopyState] = React.useState('idle')
      const copyTimer = React.useRef(null)
      ensureSpinStyles()
      const args = (block && ((block.call && block.call.args) || block.args)) || {}
      const question = typeof args.question === 'string' ? args.question : ''

      // 1.5s confirmation, then back to the neutral label. The timer is a ref so
      // a second click restarts the window instead of flashing early.
      const copyBrief = (markdown) => {
        copyText(markdown).then((ok) => {
          setCopyState(ok ? 'copied' : 'failed')
          try {
            if (copyTimer.current && typeof clearTimeout === 'function') clearTimeout(copyTimer.current)
            copyTimer.current = setTimeout(() => setCopyState('idle'), 1500)
            if (copyTimer.current && typeof copyTimer.current.unref === 'function') {
              copyTimer.current.unref()
            }
          } catch (error) {
            // The badge just stays visible; no timer is worth a crash.
          }
        })
      }
      const copyLabel = copyState === 'copied' ? '已复制'
        : copyState === 'failed' ? '复制失败' : '复制'

      if (props.phase !== 'result') {
        return frame([
          h(Header, { key: 'h', meta: '研究中…' }),
          h('div', {
            key: 'running',
            style: {
              display: 'flex', alignItems: 'center', gap: 6,
              color: CAPTION, fontSize: 13,
            },
          },
          h('span', { key: 'spin', className: SPIN_CLASS, 'aria-hidden': true }),
          h('span', { key: 'label' }, '研究中…')),
          h('div', {
            key: 'q',
            style: {
              color: CAPTION, fontSize: 13, whiteSpace: 'pre-wrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, question || '正在拆解问题并检索来源'),
        ])
      }

      const text = textOf(block || {})

      if (isErrorBlock(block)) {
        const errorText = errorTextOf(block) || '未知错误'
        const preview = errorText.slice(0, 200)
        return frame([
          h(Header, { key: 'h', badge: CONFIDENCE.low, meta: '失败' }),
          h('div', {
            key: 'e-title',
            style: { color: RED, fontWeight: 600, fontSize: 13 },
          }, '研究失败'),
          h('div', {
            key: 'e-body',
            style: { color: RED, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5 },
          }, preview),
        ])
      }

      if (!text.trim()) {
        return frame([
          h(Header, { key: 'h', meta: '无内容' }),
          h('div', {
            key: 'empty',
            style: { color: CAPTION, fontSize: 13 },
          }, '没有拿到简报'),
        ])
      }

      const confidence = confidenceOf(text)
      const sources = parseSources(text)
      const sourceTotal = sourceCount(text) || sources.length
      const seconds = elapsedOf(block)
      const runStats = runStatsOf(text)
      const stageChips = stageChipsOf(text)
      const meta = [sourceTotal > 0 ? `${sourceTotal} 个来源` : undefined,
        seconds ? `${seconds}s` : undefined].filter(Boolean).join(' · ')
      const conclusion = plain(section(text, '结论'))

      return frame([
        h(Header, {
          key: 'h',
          badge: confidence ? CONFIDENCE[confidence] : undefined,
          meta,
          copyLabel,
          copyState,
          onCopy: () => copyBrief(text),
          toggleLabel: open ? '收起' : '展开',
          onToggle: () => setOpen(!open),
        }),
        runStats ? h('div', {
          key: 'stats',
          style: {
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            font: MONO, color: CAPTION, fontSize: 11,
          },
        }, [
          `${runStats.queries} 查询`,
          `${runStats.pages} 页面`,
          `${runStats.evidence} 条证据`,
          `${runStats.seconds} 秒`,
        ].map((label) => h('span', {
          key: label,
          style: {
            border: BORDER, borderRadius: 999, padding: '0 7px',
            background: 'transparent', whiteSpace: 'nowrap',
          },
        }, label))) : null,
        // Second line: which stage ate the wall clock. Chips mirror the brief
        // text verbatim (`阶段 拆题1s` + `检索12s` + …) so copy matches reading.
        stageChips ? h('div', {
          key: 'stages',
          style: {
            display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
            font: MONO, color: CAPTION, fontSize: 10, opacity: 0.9,
          },
        }, stageChips.map((label, index) => h('span', {
          key: `stage-${index}`,
          style: {
            border: BORDER, borderRadius: 999, padding: '0 6px',
            background: 'transparent', whiteSpace: 'nowrap',
          },
        }, index === 0 ? `阶段 ${label}` : label))) : null,
        h('div', {
          key: 'c',
          style: {
            color: 'inherit', fontSize: 13, lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            ...(open ? {} : {
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }),
          },
        }, conclusion || '（无结论段）'),
        open ? h('pre', {
          key: 'full',
          style: {
            margin: 0, padding: 0, background: 'transparent', color: CAPTION,
            font: 'inherit', whiteSpace: 'pre-wrap', maxHeight: 360,
            overflowY: 'auto',
          },
        }, plain(text)) : null,
        sources.length > 0
          ? h('div', {
            key: 'sources',
            style: {
              display: 'flex', flexDirection: 'column', gap: 4,
              borderTop: BORDER, paddingTop: 6, marginTop: 2,
            },
          },
          h('button', {
            key: 'toggle',
            type: 'button',
            'aria-expanded': sourcesOpen,
            onClick: () => setSourcesOpen(!sourcesOpen),
            style: {
              alignSelf: 'flex-start', border: 'none', background: 'transparent',
              color: CAPTION, cursor: 'pointer', padding: 0, font: 'inherit',
            },
          }, sourcesOpen ? '收起来源' : `来源 ${sourceTotal}`),
          sourcesOpen ? h('ul', {
            key: 'list',
            style: {
              margin: 0, padding: 0, listStyle: 'none',
              display: 'flex', flexDirection: 'column', gap: 3,
            },
          }, sources.map((source, index) => h('li', { key: `${source.id}-${index}` },
            h('a', {
              href: source.url,
              target: '_blank',
              rel: 'noreferrer',
              title: `${source.id} ${source.label || ''} ${source.url}`.replace(/\s+/g, ' ').trim(),
              style: {
                display: 'inline-flex', alignItems: 'baseline', gap: 6,
                color: BRAND, textDecoration: 'none', minWidth: 0,
              },
            },
            h('span', { key: 'id', style: { color: CAPTION } }, source.id),
            h('span', { key: 'domain', style: { fontWeight: 600 } },
              source.domain || source.label || '链接'),
            source.label && source.domain && source.label !== source.domain
              ? h('span', {
                key: 'label',
                style: {
                  color: CAPTION, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap', maxWidth: 220,
                },
              }, source.label)
              : null)))) : null)
          : null,
      ])
    }

    const DEPTH_LABELS = {
      auto: '自动（按问题难度）',
      quick: '快速',
      standard: '标准',
      deep: '深度',
    }

    function shallowValue(form) {
      const snapshot = form && form.state
      const value = (snapshot && snapshot.value) || {}
      return { value, revision: snapshot && snapshot.revision }
    }

    /** Settings page for this row: default depth and whether the tool is offered. */
    function ConfigPanel(props) {
      const form = props.form
      const { value } = shallowValue(form)
      const [note, setNote] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const summary = `默认深度：${DEPTH_LABELS[value.depthDefault] || DEPTH_LABELS.auto}`
      if (props.view === 'summary') {
        return h('span', null, form ? summary : '默认深度：自动（配置页未就绪）')
      }

      if (!form) {
        return h('div', {
          style: { color: CAPTION, font: MONO, lineHeight: 1.6 },
        }, '配置页暂不可用：宿主没有暴露这个插件的配置命名空间。请确认插件已重启（Ctrl+R 不会重载页面）。')
      }

      const write = (field, next) => {
        if (busy) return
        setBusy(true)
        setNote('')
        setError('')
        form.mutate([{ op: 'set', path: [field], value: next }], form.state.revision).then((ok) => {
          setBusy(false)
          if (ok) setNote('已保存')
          else setError('保存被宿主拒绝')
        }).catch((failure) => {
          setBusy(false)
          setError(String((failure && failure.message) || failure))
        })
      }

      const chip = (active) => ({
        border: active ? '1px solid var(--dsw-alias-brand, #4f7cff)' : BORDER,
        background: active ? 'rgba(79,124,255,.10)' : 'transparent',
        color: active ? 'var(--dsw-alias-brand, #4f7cff)' : 'inherit',
        borderRadius: 999,
        padding: '3px 10px',
        font: MONO,
        cursor: busy ? 'default' : 'pointer',
      })

      return h('div', {
        style: {
          border: BORDER, borderRadius: 'var(--dsw-radius-lg, 10px)', padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 10, font: MONO,
          background: 'var(--dsw-alias-markdown-code-block, transparent)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { fontWeight: 600 } }, '研究深度'),
        h('span', { style: { color: CAPTION } }, '不指定 depth 时使用')),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        Object.keys(DEPTH_LABELS).map((depth) => h('button', {
          key: depth,
          type: 'button',
          disabled: busy,
          onClick: () => write('depthDefault', depth),
          style: chip((value.depthDefault || 'auto') === depth),
        }, DEPTH_LABELS[depth]))),
      h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
      },
      h('span', { style: { fontWeight: 600 } }, '启用 research 工具'),
      h('span', { style: { color: CAPTION } }, '用本页上方的插件开关控制'),
      ),
      h('div', { style: { color: CAPTION, lineHeight: 1.6 } },
        '关闭插件后模型看不到 research 工具，其余设置保留。'),
      note ? h('div', { style: { color: '#2f9e6e' } }, note) : null,
      error ? h('div', { style: { color: '#c0504d' } }, error) : null,
      )
    }

    /**
     * Live composer control: reads the plugin settings through the client
     * remote bridge and writes back with `settings.mutate`, so the depth can be
     * changed without opening the settings page. Falls back to a hint chip when
     * the bridge is unavailable.
     */
    function makeComposerControl(ctx) {
      const NAMESPACE = 'global-research'
      const CYCLE = ['auto', 'quick', 'standard', 'deep']
      return function ComposerControl() {
        const [state, setState] = React.useState({ status: 'loading', depth: 'auto', enabled: true, revision: undefined, error: '' })
        const [busy, setBusy] = React.useState(false)

        const settings = () => {
          try {
            const remote = ctx && ctx.remote
            return remote && remote.settings && typeof remote.settings.describe === 'function' ? remote.settings : undefined
          } catch (error) {
            return undefined
          }
        }

        const api = settings()

        if (!api) {
          const path = '设置 → 插件 → 全球研究 → 包含的组件 → 研究深度'
          return h('button', {
            type: 'button',
            title: `${path}\n当前环境未暴露设置写通道，请到设置页调整。`,
            onClick: () => {
              const clipboard = typeof navigator !== 'undefined' && navigator.clipboard
              if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(path).catch(() => {})
            },
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 4,
              border: BORDER, borderRadius: 999, padding: '2px 8px',
              background: 'transparent', color: CAPTION, font: MONO,
              cursor: 'pointer', whiteSpace: 'nowrap',
            },
          }, '深度：设置页')
        }

        const read = () => {
          const api = settings()
          if (!api) {
            setState({ status: 'unavailable', depth: 'auto', enabled: true, error: 'no settings bridge' })
            return
          }
          api.describe().then((response) => {
            const view = response && response.ok ? response.value : undefined
            const rows = view && Array.isArray(view.namespaces) ? view.namespaces : []
            const row = rows.find((candidate) => candidate && candidate.ns === NAMESPACE)
            if (!row) {
              setState({ status: 'unavailable', depth: 'auto', enabled: true, error: 'namespace missing' })
              return
            }
            const user = row.user || {}
            setState({
              status: 'ready',
              depth: String(user.depthDefault || 'auto'),
              enabled: user.enabled !== false,
              revision: row.revision,
              error: '',
            })
          }).catch((failure) => {
            setState({ status: 'unavailable', depth: 'auto', enabled: true, error: String((failure && failure.message) || failure) })
          })
        }

        React.useEffect(() => { read() }, [])

        const write = (field, value) => {
          const api = settings()
          if (!api || busy) return
          setBusy(true)
          api.mutate(NAMESPACE, [{ op: 'set', path: [field], value }], state.revision).then((response) => {
            setBusy(false)
            if (!response || !response.ok) {
              setState((previous) => ({ ...previous, error: '保存被宿主拒绝' }))
              return
            }
            read()
          }).catch((failure) => {
            setBusy(false)
            setState((previous) => ({ ...previous, error: String((failure && failure.message) || failure) }))
          })
        }

        if (state.status === 'unavailable') {
          const path = '设置 → 插件 → 全球研究 → 包含的组件 → 研究深度'
          return h('button', {
            type: 'button',
            title: `${path}\n当前环境未暴露设置写通道：${state.error}`,
            onClick: () => {
              const clipboard = typeof navigator !== 'undefined' && navigator.clipboard
              if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(path).catch(() => {})
            },
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 4,
              border: BORDER, borderRadius: 999, padding: '2px 8px',
              background: 'transparent', color: CAPTION, font: MONO,
              cursor: 'pointer', whiteSpace: 'nowrap',
            },
          }, '深度：设置页')
        }

        const label = DEPTH_LABELS[state.depth] || state.depth
        const chipStyle = {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          border: BORDER, borderRadius: 999, padding: '2px 8px',
          background: 'transparent', color: CAPTION, font: MONO,
          cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap',
        }
        const next = CYCLE[(CYCLE.indexOf(state.depth) + 1) % CYCLE.length]
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h('button', {
            type: 'button',
            disabled: busy,
            title: `点击切换默认研究深度（当前：${label}；下一个：${DEPTH_LABELS[next]}）。改动即时生效。`,
            onClick: () => write('depthDefault', next),
            style: chipStyle,
          }, `深度 ${state.status === 'loading' ? '…' : label}`),
          h('button', {
            type: 'button',
            disabled: busy,
            title: state.enabled ? '点击关闭 research 工具：模型将看不到它（全局生效，插件会重载）。' : '点击重新启用 research 工具。',
            onClick: () => write('enabled', !state.enabled),
            style: {
              ...chipStyle,
              color: state.enabled ? CAPTION : '#c0504d',
            },
          }, state.status === 'loading' ? '研究 …' : state.enabled ? '研究 开' : '研究 关'),
        )
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Keep a small diagnostic trail: if a seat throws, later seats still run
        // and window.__grSeats shows which ones failed and why.
        const seats = []
        if (typeof globalThis === 'object') globalThis.__grSeats = seats
        function seat(slot, options, component, label) {
          const record = { label, slot, ok: false }
          seats.push(record)
          const effect = function* () {
            try {
              yield ctx.slots.register(options, component)
              record.ok = true
            } catch (error) {
              record.error = String((error && error.stack) || error)
            }
          }
          try {
            ctx.slots.inject(slot, effect)
          } catch (error) {
            record.error = String((error && error.stack) || error)
          }
        }



        // Right side of the composer: sits beside the model selector without
        // crowding the tool row on the left.
        seat('conversation.input.right', { name: 'conversation.input.right', id: 'global-research-depth', order: 10 }, makeComposerControl(ctx), 'composer')
        seat('plugins.row.config', {
          name: 'plugins.row.config',
          key: '@local/dsh-global-research#global-research',
        }, ConfigPanel, 'config')
        seat('tool.call.toolview', {
          name: 'tool.call.toolview',
          key: 'research',
          priority: 10,
        }, ResearchCard, 'card')
      },
    }
  },
})