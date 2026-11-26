# Session import

Restores a DeepSeek Harness session-log export (`dsh-session-<id>.zip`) as a stored
session in a workspace, so the conversation returns to the sidebar and can be continued.

DSH ships export but no import. This plugin adds the missing half.

## What it does

1. Reads the export ZIP (stored or deflated entries; ZIP64 refused).
2. Finds the session log (`session.vN.jsonl`) and parses its header and events.
3. Checks the log is a contiguous export: the header version matches the filename and
   the version this Harness stores, every event carries an integer `seq`, and the
   sequence starts at 0 with no gaps.
4. Writes through `ctx.sessionPersistence` — the backend owns encoding, paths, seed
   validation, and the single-writer lock. The plugin never touches session files.
5. Attaches the session to the workspace and refreshes the sidebar projection cache,
   so the title, turn outline, and usage come back with it.

The package imports nothing from `@deepseek-ai/*`, so it resolves from any install
shape and does not break when Harness internals move.

## Usage

Ask the agent:

- "Inspect `D:\backup\dsh-session-abc.zip` without importing it" → `archivePath` + `dryRun: true`
- "Import `D:\backup\dsh-session-abc.zip`" → `archivePath`

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `dryRun` | Report contents and write nothing. Defaults to `false`. |
| `keepSourceId` | Reuse the exported session id; fails when that id exists. Defaults to a new id. |
| `workspaceId` | Target workspace. Defaults to the calling session's workspace. |

### Optional hardening

```yaml
- insert:
    - id: session-import
      name: dsh-session-log-import
      config:
        allowedRoots:
          - 'D:\session-backups'
```

With `allowedRoots` set, an archive path outside those directories is refused. With no
config any readable absolute path is accepted.

## Limitations

- **Attachments are counted, not restored.** Media and generic file entries stay out of
  the import; the result reports how many were left behind. Session text, reasoning,
  tool calls, usage, and history are restored.
- **Sub-session logs are reported, not imported.** A parent session imports alone.
- **One session per archive.** The archive must hold exactly one root `session.vN.jsonl`.
- **Only the format this Harness stores.** An export whose header version differs — from
  an older or newer DSH — is refused rather than misread.
- **Re-importing writes another session** unless `keepSourceId` collides, in which case
  it fails instead.

## Safety

- **Read-only on the archive:** parsed in memory, never extracted to disk. No code from
  the archive is evaluated, and nothing is uploaded anywhere.
- **Bounded work:** archive size, per-entry size, total inflated bytes, and event count
  are capped, so a crafted ZIP cannot expand or spin without limit.
- **Arbitrary-path read:** the tool reads a ZIP from any absolute path it is given. The
  contents are never echoed — only counts, ids, and errors — but the ability itself is
  broader than a sandboxed file tool. Set `allowedRoots` to narrow it.
- **Imported text is untrusted:** it becomes conversation history, so a hostile export
  can carry instructions into later turns. Import archives you produced yourself.
- **Imported copies repeat the source's history**, including anything sensitive that
  conversation contained. Importing does not redact anything.
