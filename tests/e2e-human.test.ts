import { describe, test } from "bun:test";

// These tests require a human operator in the OpenCode TUI.
// Run: bun test tests/e2e-human.test.ts
// All tests are skipped — they print instructions for manual verification.

describe("e2e-human: visual TUI verification", () => {
  test.skip("question tool shows interactive dialog", () => {
    console.log(`
    HUMAN TEST: Question Tool
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Ask me what language I prefer for a new project"
    3. Verify: A question dialog appears in the TUI
    4. Answer the question
    5. Verify: Claude responds based on your answer
    `);
  });

  test.skip("webfetch renders in native tool UI", () => {
    console.log(`
    HUMAN TEST: WebFetch Native Rendering
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Fetch https://example.com"
    3. Verify: Tool call shows as native "webfetch" block (not GenericTool)
    4. Verify: Output displays the fetched content
    `);
  });

  test.skip("websearch renders in native tool UI", () => {
    console.log(`
    HUMAN TEST: WebSearch Native Rendering
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Search the web for opencode github"
    3. Verify: Tool call shows as native "websearch" block (not GenericTool)
    4. Verify: Search results are displayed
    `);
  });

  test.skip("todowrite appears in sidebar", () => {
    console.log(`
    HUMAN TEST: TodoWrite Sidebar Sync
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Create a todo list: buy milk, walk dog, clean house"
    3. Verify: Tool call shows as native "todowrite" block
    4. Verify: Todos appear in the right sidebar
    `);
  });

  test.skip("edit shows diff view", () => {
    console.log(`
    HUMAN TEST: Edit Diff Rendering
    1. Open OpenCode TUI with a clwnd model in a git project
    2. Ask Claude to edit a file (e.g. "change color from red to blue in config.json")
    3. Verify: Edit tool shows a native diff view (not raw text)
    4. Verify: Added/removed lines are color-coded
    `);
  });

  test.skip("read shows file path inline", () => {
    console.log(`
    HUMAN TEST: Read Inline Rendering
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Read package.json"
    3. Verify: Read tool shows as inline "→ Read package.json" (not GenericTool)
    `);
  });

  test.skip("bash shows collapsible output", () => {
    console.log(`
    HUMAN TEST: Bash Output Rendering
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Run ls -la"
    3. Verify: Bash tool shows command description and collapsible output
    `);
  });

  test.skip("plan mode blocks edits in TUI", () => {
    console.log(`
    HUMAN TEST: Plan Mode Edit Blocking
    1. Open OpenCode TUI with a clwnd model
    2. Switch to Plan agent (Ctrl+K or agent picker)
    3. Ask: "Edit package.json and add a description field"
    4. Verify: Claude does NOT edit the file
    5. Verify: Claude explains it's in plan mode or the edit was denied
    `);
  });

  test.skip("agent switch mid-session changes behavior", () => {
    console.log(`
    HUMAN TEST: Agent Switch
    1. Open OpenCode TUI with a clwnd model in Build mode
    2. Send a message, verify it works normally
    3. Switch to Plan agent
    4. Send a message asking to edit a file
    5. Verify: Edit is blocked
    6. Switch back to Build agent
    7. Send the same edit request
    8. Verify: Edit succeeds
    `);
  });

  test.skip("streaming shows progressive output", () => {
    console.log(`
    HUMAN TEST: Streaming
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Write a detailed paragraph about the history of computing"
    3. Verify: Text appears progressively (word by word), not all at once
    `);
  });
});
