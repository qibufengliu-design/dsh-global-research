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
      props.toggleLabel
        ? h('button', {
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
      const args = (block && ((block.call && block.call.args) || block.args)) || {}
      const question = typeof args.question === 'string' ? args.question : ''

      if (props.phase !== 'result') {
        return frame([
          h(Header, { key: 'h', meta: '研究中…' }),
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
      if (block && block.isError) {
        return frame([
          h(Header, { key: 'h', badge: CONFIDENCE.low, meta: '失败' }),
          h('div', {
            key: 'e',
            style: { color: '#c0504d', whiteSpace: 'pre-wrap', fontSize: 13 },
          }, plain(text.split('\n').slice(0, 3).join('\n')) || '研究失败'),
        ])
      }

      const confidence = confidenceOf(text)
      const sources = sourceCount(text)
      const seconds = elapsedOf(block)
      const runStats = runStatsOf(text)
      const meta = [sources > 0 ? `${sources} 个来源` : undefined,
        seconds ? `${seconds}s` : undefined].filter(Boolean).join(' · ')
      const conclusion = plain(section(text, '结论'))

      return frame([
        h(Header, {
          key: 'h',
          badge: confidence ? CONFIDENCE[confidence] : undefined,
          meta,
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