# opencode-gh-plugin

An [OpenCode](https://opencode.ai) TUI plugin that adds GitHub context to the sidebar footer:

- **CI checks** — live status with auto-polling, expandable check list
- **PR link** — clickable link to the current branch's pull request
- **Session cost** — running spend for the current session (including sub-agents)
- **Working directory** — path and branch at a glance

![demo](./demo.gif)

## Install

Add the plugin to your OpenCode config (`~/.config/opencode/config.json`):

```json
{
  "tui": {
    "plugins": {
      "gh-sidebar": {
        "module": "path/to/opencode-gh-plugin/sidebar-context.tsx"
      }
    }
  }
}
```

Requires `gh` CLI to be installed and authenticated.
