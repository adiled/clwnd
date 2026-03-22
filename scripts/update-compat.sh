#!/bin/bash
set -e
cd "$(dirname "$0")/.."

CLWND_USER="${CLWND_DEV_USER:-clwnd}"
CLWND_SRC="$(eval echo ~$CLWND_USER)/.local/share/clwnd/src"

# ─── Sync test files to clwnd user ──────────────────────────────────────────

echo "Syncing test files to $CLWND_USER..."
for f in tests/smoke.test.ts tests/e2e.test.ts tests/e2e-serve.test.ts tests/e2e-human.test.ts; do
  cp "$f" "$CLWND_SRC/$f"
  chown "$CLWND_USER:$CLWND_USER" "$CLWND_SRC/$f"
done

# ─── Run all test suites as clwnd user ───────────────────────────────────────

run_as_clwnd() {
  su -l "$CLWND_USER" -c "cd $CLWND_SRC && $1" 2>&1 || true
}

# ─── Capture versions ────────────────────────────────────────────────────────

CLWND_COMMIT=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)
CLWND_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
CLAUDE_VERSION=$(run_as_clwnd "claude --version 2>/dev/null | head -1" | tr -d '\n')
OPENCODE_VERSION=$(run_as_clwnd "opencode --version 2>/dev/null | head -1" | tr -d '\n')
BUN_VERSION=$(run_as_clwnd "bun --version 2>/dev/null" | tr -d '\n')

echo "clwnd: v${CLWND_VERSION} (${CLWND_COMMIT})"
echo "claude: ${CLAUDE_VERSION}"
echo "opencode: ${OPENCODE_VERSION}"
echo "bun: ${BUN_VERSION}"

echo "Running smoke tests..."
SMOKE=$(run_as_clwnd "bun test ./tests/smoke.test.ts")

echo "Running e2e tests..."
E2E=$(run_as_clwnd "bun test ./tests/e2e.test.ts")

echo "Running e2e-serve tests..."
E2E_SERVE=$(run_as_clwnd "bun test ./tests/e2e-serve.test.ts")

echo "Running e2e-human tests..."
E2E_HUMAN=$(run_as_clwnd "bun test ./tests/e2e-human.test.ts")

# ─── Build the prompt ────────────────────────────────────────────────────────

SYSTEM_PROMPT='You generate a GitHub issue body for the clwnd compatibility index.

## What is clwnd

clwnd is a daemon + OpenCode plugin that bridges Claude Code CLI subscriptions into OpenCode. Users interact with OpenCode (the IDE/TUI), and clwnd routes their messages through a persistent Claude CLI process. clwnd owns an MCP server that handles file system tools (read, edit, write, bash, glob, grep) and brokers certain tools (webfetch, todowrite, websearch) where both Claude CLI and OpenCode execute them.

## Architecture

- **Claude CLI tools (Read, Edit, Write, Bash, Glob, Grep)**: Disallowed on Claude CLI side, replaced by MCP equivalents (`mcp__clwnd__read`, etc.). Tool names are mapped to OpenCode native names for UI rendering (e.g., `Read` → `read`, `file_path` → `filePath`).
- **Brokered tools (WebFetch, TodoWrite, WebSearch)**: Claude CLI executes them via MCP AND OpenCode re-executes them for UI state sync. Plugin emits `providerExecuted: false`.
- **Pass-through tools (Task, Skill, TodoRead, TaskOutput, CronCreate, etc.)**: Claude CLI built-ins that pass through without special handling. Some are mapped for display.
- **Agent switching**: Detected via `chat.headers` hook injecting `x-clwnd-agent` header. Agent name controls tool allowlisting (plan mode denies edit/write).
- **Session continuity**: Persistent claude process per OpenCode session. No respawn between turns.
- **Auxiliary calls**: Title gen, compaction, summarization routed to `small_model` (free opencode/* model). Safety net via `isAuxiliaryCall()` if they reach us.

## Your task

Given the test suite output below, generate the issue body with these exact sections:

### Section 1: "## Tool Calls"
A table with columns: Tool | Claude CLI | MCP | Brokered | OC Native UI | Test Coverage | Status

For each tool:
- **Status**: ✅ Working (if tests pass), ❌ Failing (if tests fail), ⚠️ Partial/Display only (if pass-through or limited), 🔇 Untested (if no test covers it)
- **Test Coverage**: List the test name(s) that cover this tool, or "—" if none
- Use the tool architecture described above to fill Claude CLI, MCP, Brokered, OC Native UI columns

Tools to include: Read, Edit, Write, Bash, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, Skill, TodoRead, TaskOutput/TaskStop, CronCreate/Delete/List

### Section 2: "## OpenCode Feature Compatibility"
Two tables.

Table 1 — Core features with columns: Feature | Status | Test Coverage | Notes
Features: Agent switching, Plan mode, Permissions (session), Permissions (agent), System prompt, Session continuity, CWD/directory

Table 2 — Extended features with columns: Feature | OC Feature | CC Equivalent | Status | Test Coverage | Notes
Features: Compaction, Snapshots/Revert, Model variants, File attachments, Cost tracking, Session forking, Title generation

For each:
- **Status**: ✅ Working (tests pass), ❌ Not working (tests fail), ⚠️ Partial, 🔇 Untested
- **Test Coverage**: exact test name(s) from the output
- **Notes**: brief explanation of how it works or why it fails. If a test failed, include a one-line summary of the failure.

### Section 3: "## Test Summary"
A compact summary table: Suite | Pass | Fail | Skip | Total

Then a "## Environment" section with a table: Component | Version — using the versions provided in the input.

Then a line: `Last updated: YYYY-MM-DD HH:MM UTC` using the timestamp provided in the input.

## Rules
- Only output the issue body markdown. No preamble, no explanation.
- Derive status ONLY from test results. If a test passes, it works. If it fails, note what failed.
- Use the exact test names from the output as test coverage references.
- Keep notes concise — max one sentence.'

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")

USER_PROMPT="Here are the test suite results. Generate the compatibility index issue body.

=== VERSIONS ===
clwnd: v${CLWND_VERSION} (${CLWND_COMMIT})
claude: ${CLAUDE_VERSION}
opencode: ${OPENCODE_VERSION}
bun: ${BUN_VERSION}
timestamp: ${TIMESTAMP}

=== SMOKE TESTS ===
${SMOKE}

=== E2E TESTS ===
${E2E}

=== E2E-SERVE TESTS ===
${E2E_SERVE}

=== E2E-HUMAN TESTS ===
${E2E_HUMAN}"

# ─── Call Claude, update issue ───────────────────────────────────────────────

echo "Generating compatibility index..."
BODY=$(claude -p --model claude-sonnet-4-5 --output-format text --system-prompt "$SYSTEM_PROMPT" "$USER_PROMPT")

echo "Updating issue #8..."
gh issue edit 8 --repo adiled/clwnd --body "$BODY"

echo "Done. View at: https://github.com/adiled/clwnd/issues/8"
