# Session import

DSH ships session-log export but no import. This plugin restores an exported
`dsh-session-<id>.zip` as a stored session, so the conversation returns to the sidebar
and can be continued.

## Capability

Adds one tool, `session_import`:

| Parameter | Meaning |
|---|---|
| `archivePath` | Absolute path to the export ZIP. Required. |
| `dryRun` | Report what the archive holds and write nothing. Defaults to `false`. |
| `keepSourceId` | Reuse the exported session id; fails when that id already exists. Defaults to a new id. |
| `workspaceId` | Target workspace. Defaults to the workspace of the calling session. |

The tool reads the ZIP, parses the session log, checks the sequence is a contiguous
export, runs seed validation, then writes through the persistence backend. The plugin
never writes session files itself, so encoding, paths, and the single-writer lock stay
with the backend.

## Usage

1. Export a session from the session header menu (`Download session log`) or `/export`.
2. Ask the agent to inspect it: "inspect `D:\backup\dsh-session-abc.zip`".
3. Ask the agent to import it: "import that archive".
4. The session appears in the sidebar under the chosen workspace. Reopen it to continue.

## Limitations

- Attachments (media and generic files) are counted but not restored; session text,
  reasoning, tool calls, usage, and history are.
- Sub-session logs are reported but not imported; one archive holds one root session.
- Only the format this Harness stores is accepted; a version mismatch is refused.
- Importing the same archive twice writes two sessions unless `keepSourceId` collides.
- Imported text is untrusted: it becomes conversation history, so import archives you
  produced yourself.

## Safety

- The archive is parsed in memory and never extracted to disk; no archive content is
  executed or uploaded.
- Archive size, entry size, total inflated bytes, and event count are capped.
- The tool reads a ZIP from any absolute path it is given; contents are never echoed,
  only counts and ids. Set `allowedRoots` in the row config to narrow the paths.
- An imported copy repeats the source conversation's history, including anything
  sensitive it contained.
