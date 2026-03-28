## Tool Calls

Tool | CC | clwnd | Brokered | OC | Cov | Status
---|---|---|---|---|---|---
Read | Disallowed | ✓ | — | ✓ | e2e-serve | ❌
Edit | Disallowed | ✓ | — | ✓ | e2e-serve | ❌
Write | Disallowed | ✓ | — | ✓ | e2e-serve | ❌
Bash | Disallowed | ✓ | — | ✓ | e2e-serve | ❌
Glob | Disallowed | ✓ | — | ✓ | — | 🔇
Grep | Disallowed | ✓ | — | ✓ | — | 🔇
WebFetch | Built-in | — | ✓ | ✓ | e2e-serve | ❌
TodoWrite | Built-in | — | ✓ | ✓ | e2e-serve | ❌
WebSearch | Built-in | — | ✓ | ✓ | — | 🔇
Task | Built-in | — | — | ✓ | — | 🔇
Skill | Built-in | — | — | ✓ | — | 🔇
TodoRead | Built-in | — | — | ✓ | — | 🔇
TaskOutput/TaskStop | Built-in | — | — | ✓ | — | 🔇
CronCreate/Delete/List | Built-in | — | — | — | — | 🔇

## OpenCode Feature Compatibility

Feature | OC | CC | Cov | Status
---|---|---|---|---
Agent switching | `--agent` | `--agent` | e2e-serve, e2e-human | ❌
Plan mode | agent type | agent type | e2e-serve | ❌
Permissions (session) | permission system | `--permission-mode` | e2e-human | 🔇
Permissions (agent) | agent config | agent config | e2e-serve | ❌
System prompt | `--prompt` | `--system-prompt` | e2e-serve | ❌
Session continuity | `--continue` | `--continue` | e2e-serve | ❌
CWD/directory | `[project]` | working directory | e2e-serve | ❌
Compaction | `session.compact` | — | e2e-serve | ❌
Snapshots/Revert | snapshot system | — | e2e-serve | ❌
Model variants | `--model` | `--model` | e2e-serve | ❌
File attachments | file API | `--file` | e2e-human | 🔇
Cost tracking | `stats` | token tracking | e2e-serve | ❌
Session forking | `--fork` | `--fork-session` | e2e-serve | ❌
Title generation | automatic | automatic | e2e-serve, e2e-human | ❌

## Test Summary

Suite | Pass | Fail | Skip | Total | Duration
---|---|---|---|---|---
e2e-serve | 0 | 41 | 0 | 41 | 10.90s
e2e-human | 0 | 0 | 7 | 7 | 6.00ms

## Environment

Component | Version
---|---
clwnd | v0.10.3 (03d75f0)
claude | 2.1.86 (Claude Code)
opencode | 1.3.3
bun | 1.3.11

## Potentially Uncovered

- `agent.cycle` — cycle through available agents
- `session.list` — list available sessions
- `session.share` — share session data

Last updated: 2026-03-28 14:01 UTC
