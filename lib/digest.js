/**
 * Turn an exported session event log into a handoff brief.
 *
 * The brief is plain text assembled from the events themselves — no model call, so it
 * is deterministic, offline, and costs nothing. It states facts (what was asked, what
 * ran, what failed, what is left) and leaves the judgement to the reader.
 *
 * @module dsh-session-log-import/lib/digest
 */

/** Default character budget for one brief. */
const DEFAULT_MAX_CHARS = 12_000
/** Hard ceiling, so a caller cannot ask for an unbounded blob. */
const MAX_CHARS_CEILING = 40_000
/** How long a single quoted line may be before it is clipped. */
const LINE_CLIP = 240
/** How many of the most recent assistant messages the "last state" section keeps. */
const RECENT_ASSISTANTS = 2

/**
 * Per-section budget share, so one long section cannot starve the others.
 * The values need not sum to one: they only bound what any single section may take.
 */
const SECTION_SHARE = {
  compaction: 0.25,
  users: 0.45,
  actions: 0.22,
  trouble: 0.22,
  todos: 0.15,
  recent: 0.18,
}

/** Patterns that look like credentials and never belong in a brief. */
const SECRET_PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/gu, '[redacted-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/gu, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/gu, '[redacted-key]'],
  // Alibaba Cloud AccessKey ID and Tencent Cloud SecretId: common in this ecosystem
  // and not covered by the generic `key = …` rule because they stand alone.
  [/\bLTAI[0-9A-Za-z]{12,20}\b/gu, '[redacted-key]'],
  [/\bAKID[0-9A-Za-z]{10,}\b/gu, '[redacted-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/gu, '[redacted-token]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gu, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, '[redacted-jwt]'],
  [/((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?)[^\s"',;]{8,}/giu, '$1[redacted]'],
  // PEM private-key blocks span lines; match them before anything reflows the text.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, '[redacted-private-key]'],
  // A brief may clip the block before its END line, so catch an orphan BEGIN plus the
  // base64 body that follows it.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\sA-Za-z0-9+/=]*/gu, '[redacted-private-key]'],
  // A password embedded in a connection URL.
  [/((?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|rediss|amqp|amqps):\/\/[^:\s/@]+:)[^@\s/]+@/giu, '$1[redacted]@'],
]

/**
 * Replace credential-shaped substrings with placeholders.
 * @param {string} text - raw text.
 * @returns {string} the text with secrets masked.
 */
export function redactSecrets(text) {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Two-digit pad. */
const pad = n => String(n).padStart(2, '0')

/**
 * Format a timestamp as local `YYYY-MM-DD HH:MM`, which reads well in a brief.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} the formatted time, or an empty string when the value is unusable.
 */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Describe a duration in the coarsest useful unit.
 * @param {number} ms - duration in milliseconds.
 * @returns {string} e.g. `3h12m`, `18m`, `40s`.
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return `${Math.round(ms / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h${pad(minutes % 60)}m`
  return `${Math.floor(hours / 24)}d${pad(hours % 24)}h`
}

/**
 * Collapse whitespace and clip to a maximum length.
 * @param {string} text - raw text.
 * @param {number} [max] - maximum characters.
 * @returns {string} one clipped line.
 */
export function oneLine(text, max = LINE_CLIP) {
  const flat = String(text).replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

/**
 * Clip text to a maximum length while keeping its line breaks intact.
 * Used where the text is already structured, such as a compaction summary.
 * @param {string} text - raw text.
 * @param {number} max - maximum characters.
 * @returns {string} the clipped text.
 */
export function clipKeepingLines(text, max) {
  const value = String(text).trim()
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

/**
 * Join the text blocks of a message content array.
 * @param {unknown} content - `contents` value from an event.
 * @returns {string} concatenated text, ignoring non-text blocks.
 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Split a `content` array into plain text and the name of any tool it invokes. */
function splitContent(content) {
  if (!Array.isArray(content)) return { text: textOf(content), blocks: [] }
  return { text: textOf(content), blocks: content.filter(b => b !== null && typeof b === 'object') }
}

/**
 * Tell a message the human typed apart from context the harness injected.
 *
 * The log records injected context as `user/message` too — runtime reminders, time
 * samples, skill catalogs, compaction checkpoints — and those would drown the real
 * requests in a brief. Typed messages carry `source.kind === 'user'`; older logs without
 * a source fall back to their opening text.
 *
 * @param {object} data - the event's data object.
 * @returns {boolean} whether the message is the human's own.
 */
function isRealUserMessage(data) {
  const kind = data.source?.kind
  if (typeof kind === 'string') return kind === 'user'
  const text = textOf(data.content).trimStart()
  return !/^(?:<system-reminder>|Time sampled while preparing|This is an automatically generated)/u.test(text)
}

/**
 * Accumulate the facts a brief needs in one pass over the events.
 * @param {object[]} events - parsed session events.
 * @returns {object} buckets of extracted facts.
 */
function collect(events) {
  const acc = {
    users: [],
    assistants: [],
    toolCalls: new Map(),
    callNames: new Map(),
    toolErrors: [],
    editedFiles: new Set(),
    turnEnds: { completed: 0, aborted: 0, error: 0, other: 0 },
    approvals: { allowed: 0, rejected: 0, rejectedTools: new Map() },
    todos: [],
    deliverables: new Map(),
    compaction: [],
    commands: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    title: '',
    model: '',
    provider: '',
    firstTime: null,
    lastTime: null,
    turns: 0,
    steps: 0,
  }

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (typeof event.time === 'number') {
      if (acc.firstTime === null || event.time < acc.firstTime) acc.firstTime = event.time
      if (acc.lastTime === null || event.time > acc.lastTime) acc.lastTime = event.time
    }
    const turn = typeof data.turn === 'number' ? data.turn : null

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') acc.title = data.title.trim()
        break
      }
      case 'user/message': {
        if (!isRealUserMessage(data)) break
        const text = textOf(data.content).trim()
        if (text !== '') acc.users.push({ turn, text })
        break
      }
      case 'assistant/message': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
        const { text } = splitContent(message.content)
        if (text.trim() !== '') acc.assistants.push({ turn, text: text.trim() })
        if (data.usage !== null && typeof data.usage === 'object') {
          acc.usage.input += Number(data.usage.inputTokens ?? 0) || 0
          acc.usage.output += Number(data.usage.outputTokens ?? 0) || 0
          acc.usage.cacheRead += Number(data.usage.cacheReadTokens ?? 0) || 0
          acc.usage.cacheWrite += Number(data.usage.cacheWriteTokens ?? 0) || 0
        }
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : '(unknown)'
        acc.toolCalls.set(name, (acc.toolCalls.get(name) ?? 0) + 1)
        if (typeof data.callId === 'string') acc.callNames.set(data.callId, name)
        const file = argumentPath(data.arguments)
        if (file !== null && (name === 'edit' || name === 'write' || name === 'str_replace_editor')) {
          acc.editedFiles.add(file)
        }
        break
      }
      case 'tool/result': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
        if (message.isError === true || (data.error !== null && typeof data.error === 'object')) {
          const detail = textOf(message.content)
          const callId = typeof message.source?.callId === 'string' ? message.source.callId : ''
          const toolName = data.error?.name ?? acc.callNames.get(callId) ?? message.source?.kind ?? ''
          acc.toolErrors.push({ turn, detail: oneLine(detail, 160), name: String(toolName) })
        }
        break
      }
      case 'turn/start': {
        acc.turns++
        break
      }
      case 'step/start': {
        acc.steps++
        break
      }
      case 'turn/end': {
        const kind = data.reason?.kind
        if (kind === 'completed') acc.turnEnds.completed++
        else if (kind === 'aborted') acc.turnEnds.aborted++
        else if (kind === 'error') acc.turnEnds.error++
        else acc.turnEnds.other++
        break
      }
      case 'approval/decided': {
        const outcome = typeof data.outcome === 'string' ? data.outcome : ''
        if (outcome === 'rejected') {
          acc.approvals.rejected++
          const tool = typeof data.toolName === 'string' ? data.toolName : ''
          if (tool !== '') acc.approvals.rejectedTools.set(tool, (acc.approvals.rejectedTools.get(tool) ?? 0) + 1)
        } else if (outcome !== '') {
          acc.approvals.allowed++
        }
        break
      }
      case 'todo/write': {
        if (Array.isArray(data.todos)) {
          acc.todos = data.todos
            .filter(t => t !== null && typeof t === 'object')
            .map(t => ({ content: String(t.content ?? ''), status: String(t.status ?? '') }))
        }
        break
      }
      case 'deliverables/presented': {
        if (Array.isArray(data.files)) {
          for (const file of data.files) {
            if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
            acc.deliverables.set(file.path, String(file.description ?? ''))
          }
        }
        break
      }
      case 'compaction/summary': {
        const text = textOf(data.summary).trim()
        if (text !== '') acc.compaction.push(text)
        break
      }
      case 'command/run': {
        const name = typeof data.name === 'string' ? data.name : ''
        if (name !== '') acc.commands.push({ kind: name, text: oneLine(String(data.args ?? ''), 120) })
        break
      }
      case 'model/selection': {
        if (typeof data.model === 'string') acc.model = data.model
        if (typeof data.provider === 'string') acc.provider = data.provider
        break
      }
      case 'request/context': {
        if (typeof data.model === 'string') acc.model = data.model
        if (typeof data.provider === 'string') acc.provider = data.provider
        break
      }
      default:
        break
    }
  }

  return acc
}

/**
 * Read a file path out of a tool-call argument blob.
 * @param {unknown} raw - the `arguments` string.
 * @returns {string|null} the path, when one of the known keys holds it.
 */
function argumentPath(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    for (const key of ['file_path', 'path', 'filePath']) {
      if (typeof parsed[key] === 'string' && parsed[key] !== '') return parsed[key]
    }
  } catch {
    return null
  }
  return null
}

/** Count a map's entries in descending order. */
const ranked = map => [...map].sort((a, b) => b[1] - a[1])

/**
 * Build the brief sections, each tagged with the priority used when the budget is tight.
 * @param {object} acc - collected facts.
 * @param {object} header - the session header.
 * @param {object} options - normalized options.
 * @returns {{key: string, priority: number, lines: string[]}[]} sections.
 */
function buildSections(acc, header, options) {
  const sections = []
  const push = (key, priority, lines) => {
    if (lines.length > 0) sections.push({ key, priority, lines })
  }

  if (acc.compaction.length > 0) {
    const lines = ['## 已有的压缩摘要（原会话自己写的，信息密度最高）', '']
    const summary = clipKeepingLines(acc.compaction.slice(-1)[0], 3000)
    for (const line of summary.split('\n')) lines.push(line === '' ? '>' : `> ${line}`)
    lines.push('')
    push('compaction', 95, lines)
  }

  if (acc.users.length > 0) {
    // Collapse consecutive repeats: the same request twice is one fact plus a weight.
    const merged = []
    for (const user of acc.users) {
      const key = oneLine(user.text, 40)
      const previous = merged[merged.length - 1]
      if (previous !== undefined && previous.key === key) {
        previous.count++
        continue
      }
      merged.push({ text: user.text, key, count: 1 })
    }

    const lines = ['## 用户请求（按时间顺序）', '']
    const total = merged.length
    const limit = Math.min(total, options.maxUserRequests)
    // Keep the opening requests (they state the goal) and the most recent ones (they
    // state where work actually stopped); drop the middle when the list is long.
    const headCount = limit <= 5 ? limit : 3
    const tailCount = limit - headCount
    const skipped = total - headCount - tailCount
    const render = (item, index) => `${index + 1}. ${oneLine(item.text, LINE_CLIP)}${item.count > 1 ? `（重复 ${item.count} 次）` : ''}`
    for (let i = 0; i < headCount; i++) lines.push(render(merged[i], i))
    if (skipped > 0) lines.push(`…中间省略 ${skipped} 条…`)
    for (let i = total - tailCount; i < total; i++) lines.push(render(merged[i], i))
    lines.push('')
    push('users', 90, lines)
  }

  const calls = ranked(acc.toolCalls)
  if (calls.length > 0) {
    const lines = ['## 执行过的动作', '', '- 工具使用：' + calls.slice(0, 12).map(([n, c]) => `${n} ×${c}`).join('、')]
    if (acc.editedFiles.size > 0) {
      const files = [...acc.editedFiles].slice(0, 20)
      lines.push(`- 写/改过的文件（${acc.editedFiles.size} 个）：` + files.join('、'))
      if (acc.editedFiles.size > files.length) lines.push(`  …另有 ${acc.editedFiles.size - files.length} 个`)
    }
    if (acc.deliverables.size > 0) {
      lines.push(`- 交付物（${acc.deliverables.size} 个）：`)
      for (const [path, description] of [...acc.deliverables].slice(0, 12)) {
        lines.push(`  - ${path}${description === '' ? '' : ` — ${oneLine(description, 120)}`}`)
      }
    }
    if (acc.commands.length > 0) {
      const seen = new Set()
      const uniq = []
      for (const c of acc.commands) {
        if (seen.has(c.kind)) continue
        seen.add(c.kind)
        uniq.push(c.kind)
      }
      lines.push('- 执行过的命令：' + uniq.slice(0, 10).map(k => `/${k}`).join('、'))
    }
    lines.push('')
    push('actions', 70, lines)
  }

  const trouble = []
  if (acc.turnEnds.error > 0) trouble.push(`- ${acc.turnEnds.error} 轮以 error 结束`)
  if (acc.turnEnds.aborted > 0) trouble.push(`- ${acc.turnEnds.aborted} 轮被中断（aborted）`)
  if (acc.approvals.rejected > 0) {
    const tools = ranked(acc.approvals.rejectedTools).map(([n, c]) => `${n}（${c}次）`).join('、')
    trouble.push(`- 有 ${acc.approvals.rejected} 次审批被拒绝${tools === '' ? '' : `：${tools}`}`)
  }
  if (acc.toolErrors.length > 0) {
    trouble.push(`- ${acc.toolErrors.length} 次工具调用报错，最近几例：`)
    for (const e of acc.toolErrors.slice(-3)) {
      trouble.push(`  - turn ${e.turn ?? '?'}${e.name === '' ? '' : ` ${e.name}`}：${e.detail}`)
    }
  }
  if (trouble.length > 0) push('trouble', 80, ['## 失败、中断与阻塞', '', ...trouble, ''])

  if (acc.todos.length > 0) {
    const open = acc.todos.filter(t => t.status !== 'completed')
    if (open.length > 0) {
      const lines = ['## 原会话的待办（最后一次 todo 记录里未完成的）', '']
      for (const t of open.slice(0, 15)) lines.push(`- [ ] ${oneLine(t.content, 160)}`)
      if (open.length > 15) lines.push(`…另有 ${open.length - 15} 项`)
      lines.push('')
      push('todos', 85, lines)
    }
  }

  const recent = acc.assistants.slice(-RECENT_ASSISTANTS)
  if (recent.length > 0) {
    const lines = ['## 最后的进展（原会话末尾的助手输出）', '']
    for (const item of recent) lines.push(oneLine(item.text, 600), '')
    push('recent', 60, lines)
  }

  return sections
}

/**
 * Assemble a brief within a character budget.
 *
 * Sections are dropped lowest-priority first; a section that still does not fit is
 * clipped rather than dropped, and the result says where it was cut.
 *
 * @param {object[]} events - parsed session events.
 * @param {object} header - the session header.
 * @param {object} [options] - `{maxChars, maxUserRequests, redact, focus}`.
 * @returns {{text: string, stats: object, truncated: boolean}} the brief and its facts.
 */
export function buildBrief(events, header, options = {}) {
  const maxChars = Math.min(
    Math.max(Number(options.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS, 1_000),
    MAX_CHARS_CEILING,
  )
  const normalized = {
    maxChars,
    maxUserRequests: Math.max(1, Math.min(Number(options.maxUserRequests ?? 40) || 40, 200)),
    redact: options.redact !== false,
    focus: typeof options.focus === 'string' ? options.focus.trim() : '',
  }

  const acc = collect(events)
  const title = acc.title !== '' ? acc.title : ''
  const cwd = typeof header?.cwd === 'string' ? header.cwd : ''
  const sourceId = typeof header?.id === 'string' ? header.id : ''
  const created = acc.firstTime !== null ? acc.firstTime : Number(header?.createdAt ?? NaN)
  const span = acc.firstTime !== null && acc.lastTime !== null && acc.lastTime > acc.firstTime
    ? formatDuration(acc.lastTime - acc.firstTime)
    : ''

  const head = ['# 会话交接简报', '']
  if (normalized.focus !== '') head.push(`**本次关注点**：${oneLine(normalized.focus, 300)}`, '')
  head.push(`- **来源会话**：${sourceId === '' ? '(未知)' : sourceId}${title === '' ? '' : `｜标题：${oneLine(title, 120)}`}`)
  if (cwd !== '') head.push(`- **原工作目录**：${cwd}`)
  const when = formatTime(created)
  if (when !== '') head.push(`- **时间**：${when}${span === '' ? '' : ` 起，跨度约 ${span}`}`)
  head.push(`- **规模**：${acc.turns} 轮 / ${acc.steps} 步 / ${events.length} 条事件`)
  if (acc.model !== '') head.push(`- **模型**：${acc.model}${acc.provider === '' ? '' : `（${acc.provider}）`}`)
  const u = acc.usage
  if (u.input + u.output > 0) {
    const cache = []
    if (u.cacheRead > 0) cache.push(`缓存读 ${u.cacheRead.toLocaleString()}`)
    if (u.cacheWrite > 0) cache.push(`缓存写 ${u.cacheWrite.toLocaleString()}`)
    head.push(`- **用量**：输入 ${u.input.toLocaleString()} tokens${cache.length === 0 ? '' : `（${cache.join(' / ')}）`} / 输出 ${u.output.toLocaleString()} tokens`)
  }
  head.push('')

  const headText = head.join('\n')
  const sections = buildSections(acc, header, normalized)
  const reserve = 90
  let budget = Math.max(maxChars - headText.length - reserve, 0)
  const kept = []
  let truncated = false
  for (const section of [...sections].sort((a, b) => b.priority - a.priority)) {
    if (budget <= 0) {
      truncated = true
      continue
    }
    const share = Math.floor(maxChars * (SECTION_SHARE[section.key] ?? 0.15))
    const cap = Math.min(budget, Math.max(share, 320))
    const block = section.lines.join('\n')
    if (block.length <= cap) {
      kept.push({ ...section, block })
      budget -= block.length + 1
      continue
    }
    const clipped = clipKeepingLines(block, cap)
    const marker = /(?:^|\n)>/u.test(clipped) ? '> …（本节已截断）' : '…（本节已截断）'
    kept.push({ ...section, block: `${clipped}\n${marker}` })
    budget -= cap + 1
    truncated = true
  }

  // Restore author-chosen order for the sections that survived.
  const order = new Map(sections.map((s, i) => [s.key, i]))
  kept.sort((a, b) => order.get(a.key) - order.get(b.key))

  let text = headText + kept.map(s => s.block).join('\n')
  if (kept.length === 0) text += '\n> 日志里没有可提取的请求、动作或进展。\n'
  if (normalized.redact) text = redactSecrets(text)
  if (truncated) text += '\n\n> 简报因长度上限被裁剪；要更多细节就调大 maxChars，或改用 session_import 导入原会话。'

  return {
    text,
    truncated,
    stats: {
      title,
      sourceId,
      turns: acc.turns,
      steps: acc.steps,
      userRequests: acc.users.length,
      toolCalls: [...acc.toolCalls.values()].reduce((a, b) => a + b, 0),
      toolErrors: acc.toolErrors.length,
      turnErrors: acc.turnEnds.error,
      turnAborted: acc.turnEnds.aborted,
      openTodos: acc.todos.filter(t => t.status !== 'completed').length,
      deliverables: acc.deliverables.size,
      editedFiles: acc.editedFiles.size,
      hadCompaction: acc.compaction.length > 0,
    },
  }
}

export { DEFAULT_MAX_CHARS, MAX_CHARS_CEILING }
