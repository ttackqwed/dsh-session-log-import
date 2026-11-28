/**
 * Render a session event log as a readable Markdown transcript.
 *
 * This is the "look at it" view: unlike the import (which restores a session) and the
 * brief (which condenses), a transcript keeps every user message, every assistant reply
 * and every tool call in order, so a human can read an export end to end.
 *
 * @module dsh-session-log-import/lib/transcript
 */

import { redactSecrets, formatTime, formatDuration, oneLine } from './digest.js'

/** Default cap on the rendered transcript, in characters. */
const DEFAULT_MAX_CHARS = 2_000_000
/** Hard ceiling a caller cannot exceed. */
const MAX_CHARS_CEILING = 8_000_000
/** How much of one tool result is quoted into the transcript. */
const TOOL_RESULT_CLIP = 600
/** How long one tool argument blob may be before it is clipped. */
const TOOL_ARGS_CLIP = 600

/** Join the text blocks of a message content array. */
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

/** Indent every line by four spaces, which is a safe Markdown code block. */
function indent(text) {
  return String(text)
    .split('\n')
    .map(line => `    ${line.replace(/\s+$/u, '')}`)
    .join('\n')
}

/** Quote a block as a Markdown block quote. */
function quote(text) {
  return String(text)
    .trim()
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** Whether a user message was typed by the human rather than injected by the harness. */
function isHuman(data) {
  const kind = data.source?.kind
  if (typeof kind === 'string') return kind === 'user'
  const text = textOf(data.content).trimStart()
  return !/^(?:<system-reminder>|Time sampled while preparing|This is an automatically generated)/u.test(text)
}

/**
 * Render the events of one session as a Markdown document.
 *
 * @param {object[]} events - parsed session events, in `seq` order.
 * @param {object} header - the session header.
 * @param {object} [options] - `{maxChars, redact, sourceFile}`.
 * @returns {{text: string, stats: object, truncated: boolean}} the document and its facts.
 */
export function buildTranscript(events, header, options = {}) {
  const maxChars = Math.min(
    Math.max(Number(options.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS, 2_000),
    MAX_CHARS_CEILING,
  )
  const redact = options.redact !== false

  const lines = []
  const toolNames = new Map()
  const stats = { turns: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolErrors: 0 }
  let title = ''
  let firstTime = null
  let lastTime = null
  let usage = { input: 0, output: 0 }
  let model = ''
  let currentTurn = null
  let truncated = false

  let written = 0
  const push = text => {
    if (written > maxChars) {
      truncated = true
      return false
    }
    lines.push(text)
    written += text.length + 1
    return true
  }

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (typeof event.time === 'number') {
      if (firstTime === null || event.time < firstTime) firstTime = event.time
      if (lastTime === null || event.time > lastTime) lastTime = event.time
    }

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title.trim()
        break
      }
      case 'model/selection':
      case 'request/context': {
        if (typeof data.model === 'string') model = data.model
        break
      }
      case 'turn/start': {
        stats.turns++
        currentTurn = typeof data.turn === 'number' ? data.turn : null
        const when = formatTime(event.time)
        if (!push(`\n---\n\n## 第 ${currentTurn ?? stats.turns} 轮${when === '' ? '' : ` · ${when}`}\n`)) break
        break
      }
      case 'user/message': {
        if (!isHuman(data)) break
        const text = textOf(data.content).trim()
        if (text === '') break
        stats.userMessages++
        if (!push(`\n### 用户\n\n${quote(text)}\n`)) break
        break
      }
      case 'assistant/message': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
        const text = textOf(message.content).trim()
        if (data.usage !== null && typeof data.usage === 'object') {
          usage.input += Number(data.usage.inputTokens ?? 0) || 0
          usage.output += Number(data.usage.outputTokens ?? 0) || 0
        }
        if (text === '') break
        stats.assistantMessages++
        if (!push(`\n### 助手\n\n${quote(text)}\n`)) break
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : '(unknown)'
        if (typeof data.callId === 'string') toolNames.set(data.callId, name)
        stats.toolCalls++
        const args = typeof data.arguments === 'string' ? data.arguments : ''
        if (!push(`\n#### 工具 · ${name}\n\n${indent(oneLine(args, TOOL_ARGS_CLIP))}\n`)) break
        break
      }
      case 'tool/result': {
        const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
        const callId = typeof message.source?.callId === 'string' ? message.source.callId : ''
        const name = toolNames.get(callId) ?? ''
        const failed = message.isError === true || (data.error !== null && typeof data.error === 'object')
        if (failed) stats.toolErrors++
        const body = textOf(message.content).trim()
        if (body === '') break
        const label = failed ? '结果 · 失败' : '结果'
        if (!push(`\n<details><summary>${label}${name === '' ? '' : ` · ${name}`}</summary>\n\n${indent(oneLine(body, TOOL_RESULT_CLIP))}\n\n</details>\n`)) break
        break
      }
      default:
        break
    }
  }

  const span = firstTime !== null && lastTime !== null && lastTime > firstTime
    ? formatDuration(lastTime - firstTime)
    : ''
  const head = [
    `# 会话转录：${title === '' ? '(无标题)' : title}`,
    '',
    `- **来源会话**：${typeof header?.id === 'string' && header.id !== '' ? header.id : '(未知)'}`,
    `- **原工作目录**：${typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : '(未知)'}`,
    `- **时间**：${formatTime(firstTime) || '(未知)'}${span === '' ? '' : ` 起，跨度约 ${span}`}`,
    `- **规模**：${stats.turns} 轮 · ${stats.userMessages} 条用户消息 · ${stats.assistantMessages} 条助手回复 · ${stats.toolCalls} 次工具调用`,
  ]
  if (model !== '') head.push(`- **模型**：${model}`)
  if (usage.input + usage.output > 0) {
    head.push(`- **用量**：输入 ${usage.input.toLocaleString()} / 输出 ${usage.output.toLocaleString()} tokens`)
  }
  head.push('', '> 由 dsh-session-log-import 从导出包生成。工具结果已截断，原始内容以导出包为准。')

  let text = `${head.join('\n')}\n${lines.join('\n')}`
  if (truncated) text += '\n\n---\n\n> 转录稿达到长度上限，后续内容已省略。调大 maxChars 可获取更多。'
  if (redact) text = redactSecrets(text)

  return { text, stats, truncated }
}

export { DEFAULT_MAX_CHARS as TRANSCRIPT_DEFAULT_MAX_CHARS, MAX_CHARS_CEILING as TRANSCRIPT_MAX_CHARS_CEILING }
