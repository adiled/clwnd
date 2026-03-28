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

```json
{
  "maxProcs": 4,
  "idleTimeout": 30000,
  "ocCompaction": false,
  "smallModel": "",
  "permissionDusk": 60000
}
```

| Key | Default | Description |
|---|---|---|
| `maxProcs` | `4` | Max concurrent Claude CLI processes |
| `idleTimeout` | `30000` | Kill idle process after ms (0 = disabled) |
| `ocCompaction` | `false` | Let OpenCode handle session compaction |
| `smallModel` | `""` | Override small model (empty = auto-discover free model) |
| `permissionDusk` | `60000` | Permission prompt timeout in ms before auto-deny |
| `droned` | `false` | Enable the drone — LLM-driven session health monitoring + auto-recovery |

**Permissions**

clwnd governs the file system operations.

opencode permissions per session are taken into account.

currently, `ask` is taken as `allow` due to some OC and CC limitations, preventing mid-prompt TUI dialogues.

writes outside allowed directories are `deny`

drop [`opencode-dir`](https://github.com/adiled/opencode-dir) into opencode config `plugins`, it allows you to `/cd`, `/mv` (soon `add-dir`) sessions
