/**
 * Browser half of dsh-session-log-import.
 *
 * Registers one row in the sidebar's global panel list and the page it selects:
 * `sidebar.panellist` (`id`) and the root-scoped `main` keyed slot share the same id,
 * which is how the host pairs a row with its page.
 *
 * The page is deliberately read-only: it explains what the three tools do and offers
 * copyable prompts. It never calls the host, so it cannot fail on a missing route.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-log-import',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The `main` key and the `sidebar.panellist` id, which must match. */
    const PANEL_ID = 'session-log-import'

    /** Sidebar glyph: an arrow dropping into a tray. */
    function PanelIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { key: 'stem', d: 'M12 3v9.5' }),
        h('path', { key: 'head', d: 'M8.2 8.8 12 12.6l3.8-3.8' }),
        h('path', { key: 'tray', d: 'M4 14.5V18a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-3.5' }),
      )
    }

    const TOOLS = [
      {
        key: 'handoff',
        name: 'session_handoff',
        purpose: '把导出包提炼成交接简报，直接进入当前对话，不用切换会话。',
        example: '把 D:\\backup\\dsh-session-abc.zip 总结一下，我要在这里接着做',
      },
      {
        key: 'view',
        name: 'session_view',
        purpose: '把整个会话渲染成 Markdown 转录稿，写到工作区，用右栏文件面板打开通读。',
        example: '把 D:\\backup\\dsh-session-abc.zip 渲染成转录稿',
      },
      {
        key: 'attachments',
        name: 'session_extract_attachments',
        purpose: '把包里的图片与文件解成普通文件，默认只能写到当前工作区内。',
        example: '把 D:\\backup\\dsh-session-abc.zip 的附件解到 D:\\backup\\abc-files',
      },
    ]

    const NOTES = [
      '输入框里敲 /session-view <路径> 也能生成转录稿：不进模型、不花 token。',
      '简报和转录稿都不带附件；需要文件时用附件导出。',
      '产物都落在工作区的 _会话日志 下，一个工具一个子目录。',
      '拖进对话的 zip 也能用：附件句柄里给出的只读路径可以直接交给插件。',
      '转录稿是原会话全文，可能包含敏感信息。',
    ]

    const styles = {
      page: {
        padding: '28px 32px 40px',
        maxWidth: '860px',
        margin: '0 auto',
        fontSize: '14px',
        lineHeight: 1.65,
        overflowY: 'auto',
        height: '100%',
        boxSizing: 'border-box',
      },
      title: { fontSize: '18px', fontWeight: 600, margin: '0 0 4px', letterSpacing: '0.01em' },
      lead: { opacity: 0.72, margin: '0 0 24px', fontSize: '13px' },
      section: { fontSize: '12px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55, margin: '26px 0 10px' },
      card: {
        border: '1px solid rgba(127,127,127,0.26)',
        borderRadius: '10px',
        padding: '12px 14px',
        marginBottom: '10px',
      },
      rowHead: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12.5px',
        padding: '2px 6px',
        borderRadius: '5px',
        background: 'rgba(127,127,127,0.14)',
      },
      purpose: { margin: '0 0 10px', opacity: 0.85 },
      example: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        margin: 0,
      },
      quote: {
        flex: '1 1 auto',
        margin: 0,
        padding: '8px 10px',
        borderRadius: '7px',
        background: 'rgba(127,127,127,0.1)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12.5px',
        wordBreak: 'break-all',
      },
      button: {
        flex: '0 0 auto',
        font: 'inherit',
        fontSize: '12px',
        padding: '6px 10px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      list: { margin: 0, paddingLeft: '20px', opacity: 0.85 },
      item: { margin: '0 0 6px' },
    }

    /** One tool card, with a copyable prompt. */
    function ToolCard({ tool }) {
      const [copied, setCopied] = React.useState(false)
      const timer = React.useRef(null)

      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current)
      }, [])

      const copy = () => {
        const clipboard = navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
        clipboard.writeText(tool.example).then(() => {
          setCopied(true)
          if (timer.current !== null) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1500)
        }).catch(() => {})
      }

      return h('div', { style: styles.card },
        h('div', { style: styles.rowHead },
          h('code', { style: styles.code }, tool.name),
        ),
        h('p', { style: styles.purpose }, tool.purpose),
        h('div', { style: styles.example },
          h('p', { style: styles.quote }, tool.example),
          h('button', { type: 'button', style: styles.button, onClick: copy, title: '复制这句话' },
            copied ? '已复制' : '复制'),
        ),
      )
    }

    /** The page the sidebar row selects. */
    function SessionImportPanel() {
      return h('div', { style: styles.page },
        h('h1', { style: styles.title }, '会话文稿'),
        h('p', { style: styles.lead }, '把导出的 dsh-session-<id>.zip 变成可读的简报、转录稿或附件文件。'),
        h('h2', { style: styles.section }, '三个工具'),
        TOOLS.map(tool => h(ToolCard, { key: tool.key, tool })),
        h('h2', { style: styles.section }, '注意'),
        h('ul', { style: styles.list },
          NOTES.map((note, index) => h('li', { key: index, style: styles.item }, note)),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 2,
          label: '会话文稿',
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, SessionImportPanel))
      },
    }
  },
})
