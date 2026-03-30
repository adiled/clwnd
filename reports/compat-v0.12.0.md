## Tool Calls

| Tool | CC | clwnd | Brokered | OC | Cov | Status |
|------|----|----|----------|----|----|--------|
| Read | Disallowed | ✓ | — | ✓ | e2e-serve | ❌ Failing |
| Edit | Disallowed | ✓ | — | ✓ | e2e-serve | ❌ Failing |
| Write | Disallowed | ✓ | — | ✓ | e2e-serve | ❌ Failing |
| Bash | Disallowed | ✓ | — | ✓ | e2e-serve | ❌ Failing |
| Glob | Disallowed | ✓ | — | ✓ | — | 🔇 Untested |
| Grep | Disallowed | ✓ | — | ✓ | — | 🔇 Untested |
| WebFetch | Built-in | ✓ | ✓ | ✓ | e2e-serve | ❌ Failing |
| WebSearch | Built-in | ✓ | ✓ | ✓ | — | 🔇 Untested |
| TodoWrite | Built-in | ✓ | ✓ | ✓ | e2e-serve | ❌ Failing |
| Task | Built-in | — | — | ✓ | — | 🔇 Untested |
| Skill | Built-in | — | — | ✓ | — | 🔇 Untested |
| TodoRead | Built-in | — | — | ✓ | — | 🔇 Untested |
| TaskOutput/TaskStop | Built-in | — | — | ✓ | — | 🔇 Untested |
| CronCreate/Delete/List | Built-in | — | — | ✓ | — | 🔇 Untested |

## OpenCode Feature Compatibility

| Feature | OC | CC | Cov | Status |
|---------|----|----|-----|--------|
| Agent switching | `--agent` | `--agent` | e2e-serve, e2e-human | ❌ Failing |
| Plan mode | agent config | `--permission-mode plan` | e2e-serve | ❌ Failing |
| Permissions (session) | session config | `--permission-mode` | e2e-serve, e2e-human | ❌ Failing |
| Permissions (agent) | agent config | agent prompt | — | 🔇 Untested |
| System prompt | `--prompt` | `--system-prompt` | e2e-serve | ❌ Failing |
| Session continuity | `--continue`, `--session` | `--continue`, `--resume` | e2e-serve | ⚠️ Partial |
| CWD/directory | project path | project arg | e2e-serve | ❌ Failing |
| Compaction | `session compact` | — | e2e-serve | ❌ Failing |
| Snapshots/Revert | snapshot API | — | e2e-serve | ❌ Failing |
| Model variants | `--model` | `--model` | e2e-serve | ❌ Failing |
| File attachments | message API | `--file` | e2e-serve, e2e-human | ❌ Failing |
| Cost tracking | stats API | — | e2e-serve | ❌ Failing |
| Session forking | `--fork` | `--fork-session` | e2e-serve | ❌ Failing |
| Title generation | auto | auto | e2e-serve, e2e-human | ❌ Failing |

## Test Summary

| Suite | Pass | Fail | Skip | Total | Duration |
|-------|------|------|------|-------|----------|
| e2e-serve | 2 | 39 | 2 | 43 | 801.48s |
| e2e-human | 0 | 0 | 7 | 7 | 6.00ms |

## Environment

| Component | Version |
|-----------|---------|
| clwnd | v0.12.0 (95e4227) |
| claude | 2.1.86 (Claude Code) |
| opencode | 1.3.7 |
| bun | 1.3.11 |

## Potentially Uncovered

- `session.list` — List available sessions for continuation
- `session.share` — Generate shareable session link or export

Last updated: 2026-03-30 19:57 UTC
