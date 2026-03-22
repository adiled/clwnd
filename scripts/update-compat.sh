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

# ─── Capture CLI references ──────────────────────────────────────────────────

CLAUDE_HELP=$(run_as_clwnd "claude --help 2>&1")
OPENCODE_HELP=$(run_as_clwnd "opencode --help 2>&1 | cat")

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

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")

PROMPT_DIR=$(mktemp -d)
trap "rm -rf $PROMPT_DIR" EXIT

cat > "$PROMPT_DIR/system.txt" <<SYSEOF
You generate a GitHub issue body for the clwnd compatibility index.

## What is clwnd

clwnd is a daemon + OpenCode plugin that bridges Claude Code CLI subscriptions into OpenCode. Users interact with OpenCode (the IDE/TUI), and clwnd routes their messages through a persistent Claude CLI process. clwnd owns an MCP server that handles file system tools (read, edit, write, bash, glob, grep) and brokers certain tools (webfetch, todowrite, websearch) where both Claude CLI and OpenCode execute them.

## Architecture

- **Claude CLI tools (Read, Edit, Write, Bash, Glob, Grep)**: Disallowed on Claude CLI side, replaced by MCP equivalents (\`mcp__clwnd__read\`, etc.). Tool names are mapped to OpenCode native names for UI rendering (e.g., Read → \`read\`, file_path → \`filePath\`).
- **Brokered tools (WebFetch, TodoWrite, WebSearch)**: Claude CLI executes them via MCP AND OpenCode re-executes them for UI state sync. Plugin emits \`providerExecuted: false\`.
- **Pass-through tools (Task, Skill, TodoRead, TaskOutput, CronCreate, etc.)**: Claude CLI built-ins that pass through without special handling. Some are mapped for display.
- **Agent switching**: Detected via \`chat.headers\` hook injecting \`x-clwnd-agent\` header. Agent name controls tool allowlisting (plan mode denies edit/write).
- **Session continuity**: Persistent claude process per OpenCode session. No respawn between turns.
- **Auxiliary calls**: Title gen, compaction, summarization routed to \`small_model\` (free opencode/* model). Safety net via \`isAuxiliaryCall()\` if they reach us.

## OpenCode CLI reference (live)

\`\`\`
${OPENCODE_HELP}
\`\`\`

## Claude Code CLI reference (live)

\`\`\`
${CLAUDE_HELP}
\`\`\`

## Your task

Given the test suite output below, generate the issue body with these exact sections:

### Section 1: "## Tool Calls"
A table with columns: Tool | Claude CLI | MCP | Brokered | OC Native UI | Test Coverage | Status

For each tool:
- **Status**: ✅ Working (if tests pass), ❌ Failing (if tests fail), ⚠️ Partial/Display only (if pass-through or limited), 🔇 Untested (if no test covers it)
- **Test Coverage**: comma-separated list of suites where the tool was tested (e.g., "smoke, e2e-serve"), or "—" if none. Do NOT list individual test names here.
- Use the tool architecture described above to fill Claude CLI, MCP, Brokered, OC Native UI columns

Tools to include: Read, Edit, Write, Bash, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, Skill, TodoRead, TaskOutput/TaskStop, CronCreate/Delete/List

### Section 2: "## OpenCode Feature Compatibility"
One table with columns: Feature | OC Feature | CC Equivalent | Status | Test Coverage
- **OC Feature**: The actual OpenCode feature/command/config name (e.g., \`session compact\`, \`--fork\`, \`small_model\`, \`--agent\`)
- **CC Equivalent**: The actual Claude Code CLI equivalent flag, command, or feature name (e.g., \`--effort\`, \`--fork-session\`, \`--resume\`, \`--agent\`). Use the CLI reference above to find exact names. If there is genuinely no CC equivalent, write "—".
- **Status**: ✅ Working (tests pass), ❌ Not working (tests fail), ⚠️ Partial, 🔇 Untested
- **Test Coverage**: comma-separated list of suites where the feature was tested (e.g., "smoke, e2e-serve"), or "—" if none. Do NOT list individual test names.

Features to include: Agent switching, Plan mode, Permissions (session), Permissions (agent), System prompt, Session continuity, CWD/directory, Compaction, Snapshots/Revert, Model variants, File attachments, Cost tracking, Session forking, Title generation

### Section 3: "## Test Summary"
A compact summary table: Suite | Pass | Fail | Skip | Total | Duration
Extract the duration from each test suite output (bun test prints it at the end, e.g., "[110.66s]").

Then a "## Environment" section with a table: Component | Version — using the versions provided in the input.

Then a line: \`Last updated: YYYY-MM-DD HH:MM UTC\` using the timestamp provided in the input.

## Rules
- Only output the issue body markdown. No preamble, no explanation.
- Derive status ONLY from test results. If a test passes, it works. If it fails, use ❌ status.
- For CC Equivalent, use actual CLI flag/command names from the reference, not "Yes"/"No"/"Not applicable".
- CRITICAL: Test Coverage column must ONLY contain comma-separated suite names from this exact set: \`smoke\`, \`e2e\`, \`e2e-serve\`, \`e2e-human\`. Nothing else. No test names, no descriptions, no qualifiers. Examples: "smoke, e2e-serve" or "e2e" or "—". Any other format is wrong.
SYSEOF

cat > "$PROMPT_DIR/user.txt" <<USREOF
Here are the test suite results. Generate the compatibility index issue body.

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
${E2E_HUMAN}
USREOF

# ─── Call Claude, update issue ───────────────────────────────────────────────

echo "Generating compatibility index..."
SYSTEM_PROMPT=$(cat "$PROMPT_DIR/system.txt")
USER_PROMPT=$(cat "$PROMPT_DIR/user.txt")
BODY=$(claude -p --model claude-sonnet-4-5 --output-format text --system-prompt "$SYSTEM_PROMPT" "$USER_PROMPT")

echo "Updating issue #8..."
gh issue edit 8 --repo adiled/clwnd --body "$BODY"

echo "Done. View at: https://github.com/adiled/clwnd/issues/8"
