import { describe, test } from "vitest";

// These tests CANNOT be automated — they require human eyes on the TUI.
// Run: bun test tests/e2e-human.test.ts
// Each skipped test is a verification checklist item.

describe("e2e-human: working features (manual verification)", () => {
  test.skip("streaming shows progressive text rendering", () => {
    // 1. Open OpenCode TUI with a clwnd model
    // 2. Ask: "Write a detailed paragraph about the history of computing"
    // 3. Verify: Text appears progressively (word by word), not all at once
  });

  test.skip("agent switching reflects in TUI header", () => {
    // 1. Start in build mode
    // 2. Switch to plan mode via /plan or agent picker
    // 3. Verify: Header shows plan agent, edit/write tools are denied
    // 4. Switch back to build
    // 5. Verify: edit/write tools work again
  });

  test.skip("tool calls render with native OC UI components", () => {
    // 1. Ask Claude to read a file — verify read tool shows file content panel
    // 2. Ask Claude to edit a file — verify edit tool shows diff panel
    // 3. Ask Claude to run a command — verify bash tool shows command output
  });

  test.skip("session title appears after first message", () => {
    // 1. Start a new session
    // 2. Send any message
    // 3. Verify: Session title updates from "New session" to a generated title
    // (Requires small_model set — daemon auto-detects free model)
  });

  test.skip("permission prompts appear for restricted operations", () => {
    // 1. Set permission to "ask" for edit in project config
    // 2. Ask Claude to edit a file
    // 3. Verify: OC shows a permission prompt before executing
  });
});

describe("e2e-human: requires TUI interaction (blocked)", () => {
  test.skip("question tool shows interactive dialog and Claude uses the answer", () => {
    // 1. Ask: "Ask me what language I prefer for a new project"
    // 2. Verify: A question dialog appears
    // 3. Type an answer
    // 4. Verify: Claude responds using your answer
    // BLOCKED: AI SDK stream lifecycle prevents brokering the question tool.
  });

  test.skip("file attachments are visible to Claude", () => {
    // 1. Attach an image or file via OC TUI
    // 2. Ask Claude to describe it
    // 3. Verify: Claude sees and describes the attachment
    // NOTE: Can't attach files via serve API — requires TUI drag/drop or paste.
  });
});
