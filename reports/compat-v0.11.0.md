## Tool Calls

| Tool | CC | clwnd | Brokered | OC | Cov | Status |
|------|-----|-------|----------|-----|-----|--------|
| Read | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Edit | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Write | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Bash | Disallowed | ✓ | — | ✓ | e2e-serve | ✅ Working |
| Glob | Disallowed | ✓ | — | ✓ | — | 🔇 Untested |
| Grep | Disallowed | ✓ | — | ✓ | — | 🔇 Untested |
| WebFetch | Built-in | ✓ | ✓ | ✓ | e2e-serve | ✅ Working |
| WebSearch | Built-in | ✓ | ✓ | ✓ | — | 🔇 Untested |
| TodoWrite | Built-in | ✓ | ✓ | ✓ | e2e-serve | ✅ Working |
| Task | Built-in | — | — | ✓ | — | 🔇 Untested |
| Skill | Built-in | — | — | ✓ | — | 🔇 Untested |
| TodoRead | Built-in | — | — | ✓ | — | 🔇 Untested |
| TaskOutput/TaskStop | Built-in | — | — | ✓ | — | 🔇 Untested |
| CronCreate/Delete/List | Built-in | — | — | ✓ | — | 🔇 Untested |

## OpenCode Feature Compatibility

| Feature | OC | CC | Cov | Status |
|---------|-----|-----|-----|--------|
| Agent switching | `--agent` | `--agent` | e2e-serve | ✅ Working |
| Plan mode | `--agent` | `--permission-mode plan` | e2e-serve | ✅ Working |
| Permissions (session) | `project` | `--add-dir` | e2e-serve | ✅ Working |
| Permissions (agent) | `--agent` | `--permission-mode` | e2e-serve | ✅ Working |
| System prompt | `--agent` | `--system-prompt` | e2e-serve | ✅ Working |
| Session continuity | `-c, --continue` | `-c, --continue` | e2e-serve | ✅ Working |
| CWD/directory | `project` | working directory | e2e-serve | ✅ Working |
| Compaction | `session.compact` | — | e2e-serve | ❌ Failing |
| Snapshots/Revert | snapshot | — | e2e-serve | ✅ Working |
| Model variants | `-m, --model` | `--model` | e2e-serve | ✅ Working |
| File attachments | attachments | `--file` | e2e-human | 🔇 Untested |
| Cost tracking | `stats` | — | e2e-serve | ✅ Working |
| Session forking | `--fork` | `--fork-session` | e2e-serve | ✅ Working |
| Title generation | automatic | automatic | e2e-serve | ✅ Working |

## Test Summary

| Suite | Pass | Fail | Skip | Total | Duration |
|-------|------|------|------|-------|----------|
| e2e-serve | 39 | 1 | 2 | 42 | 780.08s |
| e2e-human | 0 | 0 | 7 | 7 | 6.00ms |

## Environment

| Component | Version |
|-----------|---------|
| clwnd | v0.11.0 (6bb3b71) |
| claude | 2.1.86 |
| opencode | 1.3.7 |
| bun | 1.3.11 |

## Potentially Uncovered

- `agent.cycle` — cycle between configured agents in the current session
- `session.list` — show all available sessions for the current project
- `session.share` — export or publish session data externally

Last updated: 2026-03-30 09:58 UTC
