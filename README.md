<p align="center">
  <strong>\_ clwnd _/</strong>
  <br>
  A sentinel for your multiplexed cross-harness AI bots.
  <br>
  <strong>Supported today:</strong> + OpenCode session governance + Claude Code providers in headless (compliant) mode  
  <br><br>
  <img src="clwnd.gif" alt="clwnd" />
</p>

```
curl -fsSL https://raw.githubusercontent.com/adiled/clwnd/main/install | bash
```

clwnd ([/klwʊnd/](https://ipa-reader.com/?text=%2Fklw%CA%8And%2F)).

```
clwnd update
clwnd status
clwnd logs
clwnd sessions
clwnd uninstall
```

Needs git, bun, opencode, claude.

Core workflow is operational (more coming). See [compatibility](https://github.com/adiled/clwnd/issues/8).

**Config** `~/.config/clwnd/clwnd.json`

| Key | Default | Description |
|---|---|---|
| `maxProcs` | `4` | Max concurrent Claude CLI processes |
| `idleTimeout` | `30000` | Kill idle process after ms (0 = disabled) |
| `smallModel` | `""` | Override small model (empty = auto-discover free model) |
| `permissionDusk` | `60000` | Permission prompt timeout in ms before auto-deny |
| `droned` | `false` | Enable the drone — stream observer, context-loss detection, auto-recovery |
| `droneModel` | `opencode-clwnd/claude-haiku-4-5` | Model for drone LLM assessments |

**Permissions**

clwnd routes Claude CLI's permission prompts through OpenCode's `ctx.ask()`. The OC TUI permission dialog appears when a tool call requires approval.

Writes outside allowed directories are denied by clwnd's MCP path enforcement.

**External MCP**

MCP servers configured in `opencode.json` are available to Claude. clwnd's daemon spawns and proxies local MCP servers (e.g. context7). Auth-bound (OAuth) MCPs are not yet supported.

**Plugins**

drop [`opencode-dir`](https://github.com/adiled/opencode-dir) into opencode config `plugins` for `/cd`, `/mv` session directory commands
