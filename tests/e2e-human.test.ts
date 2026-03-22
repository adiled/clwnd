import { describe, test } from "bun:test";

// These tests CANNOT be automated — they require human eyes on the TUI.
// Run: bun test tests/e2e-human.test.ts

describe("e2e-human: requires TUI interaction", () => {
  test.skip("question tool shows interactive dialog and Claude uses the answer", () => {
    console.log(`
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Ask me what language I prefer for a new project"
    3. Verify: A question dialog appears
    4. Type an answer
    5. Verify: Claude responds using your answer
    `);
  });

  test.skip("streaming shows progressive text rendering", () => {
    console.log(`
    1. Open OpenCode TUI with a clwnd model
    2. Ask: "Write a detailed paragraph about the history of computing"
    3. Verify: Text appears progressively (word by word), not all at once
    `);
  });
});
