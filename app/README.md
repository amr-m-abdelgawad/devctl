# devctl (`ts/`)

This directory is the application. Runtime is [Bun](https://bun.sh). The TUI is [OpenTUI](https://opentui.com/docs/).

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun run src/bin.ts --help
bun test
```

TUI preferences: [`tui.json`](./tui.json) or `DEVCTL_TUI_CONFIG`.

Wiki: [docs/](../docs/README.md) — start with [how it fits together](../docs/overview.md) and [building from source](../docs/typescript.md).
