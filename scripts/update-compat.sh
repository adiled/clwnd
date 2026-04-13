#!/bin/bash
set -e
cd "$(dirname "$0")/.."

CLWND_USER="${CLWND_DEV_USER:-clwnd}"
CLWND_SRC="$(eval echo ~$CLWND_USER)/.local/share/clwnd/src"

# ─── Sync test files to clwnd user ──────────────────────────────────────────

echo "Syncing test files to $CLWND_USER..."
for f in tests/e2e-serve.test.ts tests/e2e-human.test.ts; do
  cp "$f" "$CLWND_SRC/$f"
  chown "$CLWND_USER:$CLWND_USER" "$CLWND_SRC/$f"
done
mkdir -p "$CLWND_SRC/tests/fixtures"
cp tests/fixtures/* "$CLWND_SRC/tests/fixtures/" 2>/dev/null
chown -R "$CLWND_USER:$CLWND_USER" "$CLWND_SRC/tests/fixtures" 2>/dev/null

# ─── Run all test suites as clwnd user ───────────────────────────────────────

run_as_clwnd() {
  su -l "$CLWND_USER" -c "cd $CLWND_SRC && $1" 2>&1 || true
}

# ─── Capture CLI references and config schema ────────────────────────────────

CLAUDE_HELP=$(run_as_clwnd "claude --help 2>&1")
OPENCODE_HELP=$(run_as_clwnd "opencode --help 2>&1 | cat")

# Extract built-in TUI commands from the SDK types
OC_SDK_TYPES=$(find /home/$CLWND_USER/.config/opencode /home/$CLWND_USER/.opencode -path "*/sdk/dist/gen/types.gen.d.ts" 2>/dev/null | head -1)
OC_TUI_COMMANDS=""
if [ -n "$OC_SDK_TYPES" ]; then
  OC_TUI_COMMANDS=$(grep 'session\.list.*session\.new' "$OC_SDK_TYPES" | grep -oP '"[a-z]+\.[a-z._]+"' | tr -d '"' | sort -u | paste -sd, -)
fi

# ─── Capture versions ────────────────────────────────────────────────────────

CLWND_COMMIT=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD)
CLWND_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
CLAUDE_VERSION=$(run_as_clwnd "claude --version 2>/dev/null | head -1" | tr -d '\n')
OPENCODE_VERSION=$(run_as_clwnd "opencode --version 2>/dev/null | head -1" | tr -d '\n')
NODE_VERSION=$(run_as_clwnd "node --version 2>/dev/null" | tr -d '\n')

echo "clwnd: v${CLWND_VERSION} (${CLWND_COMMIT})"
echo "claude: ${CLAUDE_VERSION}"
echo "opencode: ${OPENCODE_VERSION}"
echo "node: ${NODE_VERSION}"

echo "Running e2e-serve tests..."
E2E_SERVE=$(run_as_clwnd "vitest run ./tests/e2e-serve.test.ts")

echo "Running e2e-human tests..."
E2E_HUMAN=$(run_as_clwnd "vitest run ./tests/e2e-human.test.ts")

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

## OpenCode built-in TUI commands (live from SDK types)

${OC_TUI_COMMANDS}

## Your task

Given the test suite output below, generate the issue body with these exact sections:

### Section 1: "## Tool Calls"
Table with EXACTLY these columns in this order: Tool | CC | clwnd | Brokered | OC | Cov | Status

Column rules:
- **Tool**: tool name
- **CC**: Claude CLI side — "Disallowed" for MCP tools, "Built-in" for pass-through/brokered tools
- **clwnd**: ✓ if handled by clwnd MCP, — if not
- **Brokered**: ✓ if brokered (both sides execute), — if not
- **OC**: ✓ if renders natively in OpenCode UI, — if not
- **Cov**: comma-separated suite names, or — if none
- **Status**: ✅ Working, ❌ Failing, ⚠️ Partial, 🔇 Untested. Skipped tests count as untested, NOT failing.

Tools to include: Read, Edit, Write, Bash, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, Skill, TodoRead, TaskOutput/TaskStop, CronCreate/Delete/List

### Section 2: "## OpenCode Feature Compatibility"
Table with EXACTLY these columns in this order: Feature | OC | CC | Cov | Status

Column rules:
- **Feature**: feature name
- **OC**: The actual OpenCode feature/command/config name (e.g., \`session compact\`, \`--fork\`, \`small_model\`). Use the CLI and TUI command references above.
- **CC**: The actual Claude Code CLI equivalent flag or command (e.g., \`--effort\`, \`--fork-session\`, \`--resume\`). Use the CLI reference above. — if no equivalent.
- **Cov**: comma-separated suite names, or — if none
- **Status**: ✅ Working, ❌ Failing, ⚠️ Partial, 🔇 Untested

Features to include: Agent switching, Plan mode, Permissions (session), Permissions (agent), System prompt, Session continuity, CWD/directory, Compaction, Snapshots/Revert, Model variants, File attachments, Cost tracking, Session forking, Title generation

### Section 3: "## Test Summary"
A compact summary table: Suite | Pass | Fail | Skip | Total | Duration
Extract the duration from each test suite output (vitest run prints it at the end, e.g., "[110.66s]").

Then a "## Environment" section with a table: Component | Version — using the versions provided in the input.

### Section 4: "## Potentially Uncovered"
Look ONLY at the OpenCode built-in TUI commands listed above. For each TUI command, determine if the test suites exercise the feature it represents. List any TUI commands that have NO corresponding test coverage. Skip navigation commands (page.up, page.down, half.page.up, half.page.down, first, last) and pure UI commands (prompt.clear, prompt.submit) — these don't touch the provider. Format as a bullet list: \`command.name\` — one-line description of what it does. Do NOT list CLI flags from either tool — only OpenCode TUI commands.

Then a line: \`Last updated: YYYY-MM-DD HH:MM UTC\` using the timestamp provided in the input.

## Rules
- CRITICAL: Output ONLY the raw markdown. No preamble, no "Here is...", no "I'll generate...", no explanation. Start directly with "## Tool Calls".
- Status is PER ROW, not global. Read each test name carefully and match it to the specific tool or feature it tests. A passing test for "read produces tool part" means Read is ✅. A failing test for "concurrent sessions" means only concurrent-related rows get ❌. Do NOT spread a failure across unrelated rows.
- (pass) = ✅, (fail) = ❌, test.skip = 🔇, no matching test = 🔇.
- For CC Equivalent, use actual CLI flag/command names from the reference, not "Yes"/"No"/"Not applicable".
- CRITICAL: Test Coverage column must ONLY contain comma-separated suite names from this exact set: \`e2e\`, \`e2e-serve\`, \`e2e-human\`. Nothing else. No test names, no descriptions, no qualifiers. Examples: "smoke, e2e-serve" or "e2e" or "—". Any other format is wrong.
SYSEOF

cat > "$PROMPT_DIR/user.txt" <<USREOF
Here are the test suite results. Generate the compatibility index issue body.

=== VERSIONS ===
clwnd: v${CLWND_VERSION} (${CLWND_COMMIT})
claude: ${CLAUDE_VERSION}
opencode: ${OPENCODE_VERSION}
node: ${NODE_VERSION}
timestamp: ${TIMESTAMP}

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

REPORT_FILE="$(dirname "$0")/../reports/compat-v${CLWND_VERSION}.md"
echo "$BODY" > "$REPORT_FILE"
echo "Saved report to $REPORT_FILE"

echo "Updating issue #8..."
gh issue edit 8 --repo adiled/clwnd --body "$BODY"

echo "Done. View at: https://github.com/adiled/clwnd/issues/8"
