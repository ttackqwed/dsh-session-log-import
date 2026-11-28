# Session handoff, transcript & attachments

Turns a DeepSeek Harness session-log export (`dsh-session-<id>.zip`) into readable output,
three ways:

- **`session_handoff`** — summarizes it into a brief that arrives in the *current*
  conversation, so work can continue here without switching sessions.
- **`session_view`** — renders the whole conversation as a Markdown transcript file you can
  read in the right sidebar; nothing is condensed.
- **`session_extract_attachments`** — copies the `media/` and `files/` entries out as
  ordinary files, because neither a brief nor a transcript carries their bytes.

This plugin **does not restore a session**. An export stays an archive; what changes is
that you can read it, resume from it, and get its files back.

## What it does

1. Reads the export ZIP (stored or deflated entries; ZIP64 refused).
2. Finds the session log (`session.vN.jsonl`) and parses its header and events.
3. Checks the log is a contiguous export: every event carries an integer `seq`, and the
   sequence starts at 0 with no gaps.
4. On handoff, assembles a brief from the events themselves (no model call, so it is
   deterministic and free) and returns it into the calling conversation.
5. On view, renders every message and tool call into one Markdown file under the
   workspace. The same rendering is reachable from a slash command,
   `/session-view <zip>`.
6. On extraction, writes the `media/` and `files/` entries into a directory, with each
   name reduced to a safe base name — never into the session store.

Everything the plugin writes lands under one workspace directory, `_会话日志/`, in a
subdirectory per tool, so three kinds of output never mix:

| Tool | Directory | Content |
|---|---|---|
| `session_handoff` | `_会话日志/交接简报/` | `<sourceId>.md` — the brief, also returned inline |
| `session_view` | `_会话日志/转录稿/` | `<sourceId>.md` — the full transcript |
| `session_extract_attachments` | `_会话日志/附件/<archive name>/` | the attachment files |

Deleting `_会话日志/` removes only derived files.

The package imports nothing from `@deepseek-ai/*`, so it resolves from any install
shape and does not break when Harness internals move.

## Usage

Ask the agent:

- "Summarize `D:\backup\dsh-session-abc.zip` here so we can pick up where it stopped"
  → `session_handoff`
- "Render `D:\backup\dsh-session-abc.zip` as a transcript I can read" → `session_view`
- "Pull the attachments out of `D:\backup\dsh-session-abc.zip`" → `session_extract_attachments`

Or from the composer, without the model: `/session-view D:\backup\dsh-session-abc.zip`

A Chinese walkthrough — installation, every parameter, the full error table, and
hardening — lives in [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md).

### session_handoff

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `focus` | What to pay attention to when resuming; shown at the top of the brief. |
| `maxChars` | Brief size budget. Defaults to `12000`, capped at `40000`. |

### session_view

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `outputDir` | Absolute directory for the transcript. Defaults to `_会话日志/转录稿` in the workspace. |
| `maxChars` | Transcript budget. Defaults to `2,000,000`, capped at `8,000,000`. |

The transcript is a single Markdown file: one section per turn, the user's message as a
quote, the assistant's reply as a quote, and each tool call with its arguments and a
clipped result in a collapsible block. Harness-injected context is filtered out.

### session_extract_attachments

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `outputDir` | Absolute directory to write into. Defaults to `_会话日志/附件/<archive name>` in the workspace; must stay inside the workspace unless `allowAnyOutputDir` is configured. |
| `overwrite` | Replace existing files. Defaults to `false`, which skips them. |

Entry names lose their directory components, illegal characters become `_`, a Windows
reserved name gets a `_` prefix, and a name that appears twice gains a `-2` suffix. The
`sha256:` prefix on content-addressed media names is stripped.

Credential-shaped strings are masked in both text outputs. Only an operator can lift that,
by setting `allowUnredacted: true` in the plugin row config.

## What the handoff brief contains

Assembled from the log, in this order:

- source session id, title, original working directory, time span, turns/steps/events,
  model, and token usage;
- the session's own compaction summary, if it had one — the densest signal available;
- the user's requests in order, with runs of identical requests collapsed to
  `(repeated N times)` and the middle elided when the list is long;
- tools used, files written, delivered artifacts, and slash commands run;
- failed and aborted turns, rejected approvals, and recent tool errors;
- open todos from the session's last `todo_write`;
- the last assistant output, which usually states where the work stopped.

Injected context the Harness writes into the log — runtime reminders, time samples,
skill catalogs, compaction checkpoints — is filtered out, so only what the human typed
counts as a request.

## Limitations

- **No session is restored.** There is no tool that writes a session back into the store;
  an export remains an archive you read from.
- **Attachments never ride along.** A brief and a transcript are text only;
  `session_extract_attachments` recovers the bytes into a directory.
- **Sub-session logs are not exported.** Only the root session's log is read.
- **One session per archive.** The archive must hold exactly one root `session.vN.jsonl`.
- **The brief is not a conversation.** It is text in the current turn; the other session's
  tool outputs, attachments, and hidden state are not replayed.

## Safety

- **Read-only on stored sessions:** the plugin never touches the Harness session store.
- **Parsed in memory:** archive content is never extracted to disk, no code from the
  archive is evaluated, and nothing is uploaded anywhere. Only an explicit extraction or
  transcript request writes a file.
- **Bounded work:** archive size, per-entry size, total inflated bytes, and event count
  are capped, so a crafted ZIP cannot expand or spin without limit.
- **Asynchronous reads:** decompression never blocks the host's event loop.
- **Arbitrary-path read:** all three tools read a ZIP from any absolute path they are
  given. Set `allowedRoots` to narrow it.
- **Writing is narrower than reading.** Extraction writes ordinary files, and the target
  directory must sit inside the calling session's workspace unless the row config sets
  `allowAnyOutputDir: true`. Directory components are stripped from entry names, so an
  archive cannot steer a write outside the target.
- **Exported text is untrusted:** it becomes current context (handoff) or a file you open,
  so a hostile export can carry instructions into later turns. Use archives you produced
  yourself.
