## Tool Calls

| Tool | CC | clwnd | Brokered | OC | Cov | Status |
|------|-----|-------|----------|-----|-----|--------|
| Read | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Edit | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Write | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Bash | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Glob | Disallowed | ✓ | — | ✓ | — | 🔇 Untested |
| Grep | Disallowed | ✓ | — | ✓ | — | 🔇 Untested |
| WebFetch | Built-in | — | ✓ | ✓ | e2e-serve | ✅ Working |
| WebSearch | Built-in | — | ✓ | ✓ | — | 🔇 Untested |
| TodoWrite | Built-in | — | ✓ | ✓ | e2e-serve | ✅ Working |
| Task | Built-in | — | — | ✓ | — | 🔇 Untested |
| Skill | Built-in | — | — | ✓ | — | 🔇 Untested |
| TodoRead | Built-in | — | — | ✓ | — | 🔇 Untested |
| TaskOutput/TaskStop | Built-in | — | — | ✓ | — | 🔇 Untested |
| CronCreate/Delete/List | Built-in | — | — | ✓ | — | 🔇 Untested |

## OpenCode Feature Compatibility

| Feature | OC | CC | Cov | Status |
|---------|-----|-----|-----|--------|
| Agent switching | `--agent` | `--agent` | e2e-serve | ✅ Working |
| Plan mode | agent permission mode | `--permission-mode plan` | e2e-serve | ✅ Working |
| Permissions (session) | session permissions | `--permission-mode` | e2e-human | 🔇 Untested |
| Permissions (agent) | agent permissions | agent definition | e2e-serve | ✅ Working |
| System prompt | `--prompt` | `--system-prompt` | e2e-serve | ✅ Working |
| Session continuity | `--continue` | `--continue` | e2e-serve | ⚠️ Partial |
| CWD/directory | `[project]` | working directory | e2e-serve | ✅ Working |
| Compaction | `session.compact` | automatic | e2e-serve | ❌ Failing |
| Snapshots/Revert | snapshot system | — | e2e-serve | ✅ Working |
| Model variants | `--model` | `--model` | e2e-serve | ✅ Working |
| File attachments | attachment API | `--file` | e2e-serve, e2e-human | ⚠️ Partial |
| Cost tracking | `stats` | `--max-budget-usd` | e2e-serve | ✅ Working |
| Session forking | `--fork` | `--fork-session` | e2e-serve | ✅ Working |
| Title generation | automatic | automatic | e2e-serve | ✅ Working |

## Test Summary

| Suite | Pass | Fail | Skip | Total | Duration |
|-------|------|------|------|-------|----------|
| e2e-serve | 37 | 4 | 0 | 41 | 1026.92s |
| e2e-human | 0 | 0 | 7 | 7 | 0.01s |

## Environment

| Component | Version |
|-----------|---------|
| clwnd | v0.10.3 (e344ca1) |
| claude | 2.1.86 |
| opencode | 1.3.3 |
| bun | 1.3.11 |

## Potentially Uncovered

- `agent.cycle` — cycle through available agents
- `session.list` — list all sessions
- `session.share` — share session data

Last updated: 2026-03-28 14:22 UTC
