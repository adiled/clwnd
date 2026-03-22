<p align="center">
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

**Permissions**

clwnd governs the file system operations.

opencode permissions per session are taken into account.

currently, `ask` is taken as `allow` due to some OC and CC limitations, preventing mid-prompt TUI dialogues.

writes outside allowed directories are `deny`

drop [`opencode-dir`](https://github.com/adiled/opencode-dir) into opencode config `plugins`, it allows you to `/cd`, `/mv` (soon `add-dir`) sessions
