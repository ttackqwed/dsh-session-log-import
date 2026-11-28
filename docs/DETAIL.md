# Session handoff, transcript & attachments

DSH ships session-log export but no import. This plugin does not add import either: it
makes an export **readable**. One archive yields a handoff brief you can resume from, a
Markdown transcript you can read in the right sidebar, or its attachments as ordinary
files.

## Capability

Adds three tools.

`session_handoff`:

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `focus` | What to pay attention to when resuming; shown at the top of the brief. |
| `maxChars` | Brief budget in characters. Defaults to `12000`, capped at `40000`. |

`session_view`:

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `outputDir` | Absolute directory for the transcript. Defaults to `_会话日志/转录稿`. |
| `maxChars` | Transcript budget. Defaults to `2,000,000`, capped at `8,000,000`. |

The same rendering is available as the slash command `/session-view <zip>`, which runs
without the model.

`session_extract_attachments`:

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `outputDir` | Absolute directory to write into. Defaults to `_会话日志/附件/<archive name>`; must stay inside the workspace unless `allowAnyOutputDir` is configured. |
| `overwrite` | Replace existing files. Defaults to `false`. |

The handoff path reads the ZIP, parses the log, and assembles a brief from its events:
requests, tools used, files written, failed and interrupted turns, open todos, and the
last progress. No model call is involved, so the result is deterministic and costs nothing.

The view path renders the whole log — every message and tool call — into one Markdown
file. The extraction path writes the `media/` and `files/` entries as ordinary files,
with names reduced to a safe base name so an archive cannot steer a write outside the
target.

Everything the plugin writes lands under one workspace directory, `_会话日志/`, with a
subdirectory per tool — `交接简报/`, `转录稿/`, `附件/` — so the three kinds of output
never mix. The Harness session store is never touched.

Reads are asynchronous throughout, so a large export never blocks the host's event loop.

## Usage

1. Export a session from the session header menu (`Download session log`) or `/export`.
2. To continue in this conversation: "summarize `D:\backup\dsh-session-abc.zip` here".
3. To read it as a document: `/session-view D:\backup\dsh-session-abc.zip`, then open the
   Markdown file it names from the right sidebar's file browser.
4. To recover the files: "extract the attachments from that zip".

## Limitations

- No session is restored: an export remains an archive you read from.
- Attachments never ride along with a brief or a transcript;
  `session_extract_attachments` copies them out as plain files instead.
- One archive holds one root session log; sub-session logs are not exported.
- The brief is not a conversation: the other session's tool outputs and hidden state are
  not replayed.

## Safety

- The archive is parsed in memory and never extracted to disk; no archive content is
  executed or uploaded.
- Archive size, entry size, total inflated bytes, and event count are capped.
- All three tools read a ZIP from any absolute path they are given. Set `allowedRoots` in
  the row config to narrow the paths.
- Extraction writes ordinary files and stays inside the workspace directory unless
  `allowAnyOutputDir: true` is configured.
- Credential-shaped strings are masked in generated text; only the row config
  `allowUnredacted: true` lifts that.
