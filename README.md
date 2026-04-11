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

**External MCP**

MCP servers configured in `opencode.json` are available to Claude. clwnd's daemon spawns and proxies local MCP servers (e.g. context7). Auth-bound (OAuth) MCPs are not yet supported.

clwnd denies file writes in directories parent to `cwd`. Until ask is supported for that, you can use [`opencode-dir`](https://github.com/adiled/opencode-dir) plugin's `/cd` and `/mv` commands to relocate your session to the desired directory.

**Usage limits (for users on Claude subscription)**

As of April 4, 2026, Anthropic routes third-party harness traffic to a separate "extra usage" bucket. Points worth knowing:

- **Transition credit**: a one-time credit ($20 Pro / $100 Max 5× / $200 Max 20×) is available at `claude.ai/settings/usage`. You must **enable "extra usage"** in the web UI to claim it. The claim window **closes April 17, 2026** — then the credit expires 90 days later.
- **Don't click the April-5 "refund" link** in Anthropic's notification email — [GH #45662](https://github.com/anthropics/claude-code/issues/45662) reports it voiding already-claimed credits.
- **Peak-hour throttling** applies during **05:00–11:00 PT / 13:00–19:00 GMT** — an Anthropic engineer estimated ~7% more users hit limits during these windows. Shift heavy sessions outside them where possible.
- clwnd is a local execution utility (see [NOTICE](NOTICE)) — it rides on whatever auth the invoked `claude` binary uses on your machine. If your Claude CLI is OAuth-authed, clwnd traffic counts against the extra-usage bucket; if it's API-key authed, it bills against your API account as usual. clwnd does not touch or alter auth either way.
