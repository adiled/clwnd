# OpenCode Workspace Discovery

Investigated OpenCode 1.3.3 control-plane/workspace system. Notes for future reference.

## What It Is

A control plane abstraction for running OC sessions on remote compute environments. A workspace represents where sessions execute — decoupled from the TUI/client.

## Architecture

- **Workspace** — named compute environment with type, status, lifecycle events
- **WorkspaceServer** (`opencode workspace-serve`) — separate HTTP server proxying session routes for a workspace. Not part of regular `opencode serve`.
- **WorkspaceContext** — async context carrying `workspaceID` through the call stack
- **Adaptors** — pluggable backends. Only `worktree` (git worktree) exists today. `installAdaptor()` allows registering custom types (marked experimental/testing).
- **Syncing** — event sourcing system landed in 1.3.3. Single-writer model: one device writes session events, others replay. Built for workspace replication across devices.

## Key Files

```
packages/opencode/src/control-plane/
  workspace.ts              — Workspace CRUD, events (Ready, Failed)
  workspace-context.ts      — Async context provider for workspaceID
  workspace.sql.ts          — DB schema
  schema.ts                 — WorkspaceID type
  types.ts                  — WorkspaceInfo, Adaptor interface
  adaptors/
    index.ts                — Registry, getAdaptor(), installAdaptor()
    worktree.ts             — Git worktree adaptor (only one)
  workspace-server/
    server.ts               — Hono HTTP server, routes session requests

packages/opencode/src/sync/
    index.ts                — SyncEvent, event sourcing, projectors
    README.md               — Design doc: single-writer, total ordering, Bus compat
    schema.ts               — Event schema (id, seq, type, aggregate, data)
    event.sql.ts            — Event persistence
```

## Current State

Early. The workspace-serve command works but the adaptor system is experimental. The sync system just landed (1.3.3) and is backwards-compatible with Bus events. The worktree adaptor is the only implementation.

## Relevance to clwnd

Workspaces are about WHERE sessions run. clwnd is about HOW sessions run (routing through Claude CLI instead of direct API). Orthogonal today.

But if OC evolves workspaces to mean "remote Claude Code execution environments," that converges with what clwnd does. A `clwnd` workspace adaptor could be the native integration path — instead of being a provider plugin that wraps Claude CLI, clwnd becomes a workspace type that OC natively understands.

The `installAdaptor()` function is the hook point. Currently experimental but the architecture is there.

## Syncing Implications

The sync system means OC sessions can be replayed on other devices. clwnd's JSONL seeding does something similar — replaying OC history into Claude CLI. If OC's sync events become accessible to plugins, clwnd could subscribe to session events and maintain Claude CLI's JSONL in real-time instead of doing batch exports on model switch.
