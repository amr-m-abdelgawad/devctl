# TUI

The TUI is [OpenTUI](https://opentui.com/docs/) (`@opentui/core` + `@opentui/react`). It attaches to the supervisor and never owns child processes.

```bash
cd examples/demo-platform
bun run ../../app/src/bin.ts
```

If a supervisor session already exists, the TUI attaches to it. Preferences: `tui.json` / `DEVCTL_TUI_CONFIG` — see [Building from source](typescript.md).

## First run

With no `.devctl` configuration the TUI opens **setup**: “No configuration found. Would you like to run setup? **[Enter] Setup [Esc] Exit**”. Enter writes a starter config (or run `devctl setup` for the 9-step wizard).

If a `.devctl/config.yaml` exists but fails to parse or validate, the TUI shows **Configuration error** with the actual error instead — pressing Enter here does not run setup, since that would silently overwrite the file the error is about. Fix the file and restart devctl, or run `devctl config validate` for the same error from the CLI.

When services exist but none are running, the dashboard empty state:

- `enter` starts the default profile (first profile name alphabetically) after a plan overlay
- `n` / `x` start or stop the highlighted row (or the space-selected set)
- a **lifecycle panel** shows start and stop waves; later start waves wait for health and do not run if a wave fails
- the panel stays open until `esc` so you can read the result
- `o` picks a profile, then confirms start

## Quit

`q` / `/exit` / `ctrl+c` twice:

| `shutdown.stop_services_on_exit` | Behavior |
|----------------------------------|----------|
| `true` | Stop managed services and leave |
| `false` | Detach immediately |
| unset | Confirm: `enter` stops, `d` detaches, `esc` stays |

## Interaction model

Keyboard-first:

| Input | What it does |
|-------|----------------|
| `/` | Slash command line — `↑`/`↓` move the suggestion, `enter` runs it |
| `ctrl+p` | Grouped command palette |
| `ctrl+x` | Leader key (2s), then a shortcut — keymap overlay |
| `?` | Grouped help — `j`/`k` scroll when the list is taller than the terminal |
| `tab` / `shift+tab` / `1`–`9` / `0` | Cycle or jump **nav tabs**. `0` is the 10th tab (**setup**). Settings is the 11th tab — use `tab` or `/settings`. When the strip is wider than the terminal it slides (`‹` `›`). |
| `s` `l` `a` `p` `d` `c` `u` | Direct letter nav when no overlay owns keys (services, logs, identity, proxy, doctor, config, setup) |
| `r` | Refresh snapshot (doctor `r` re-runs checks) |
| `R` | Restart selected services |
| `j` `k` / arrows | Move selection |
| `enter` | Start (empty dashboard) or open service detail |
| `space` | Multi-select a service |
| `esc` | Back / close overlay |
| `f` | Focus log search (`g` jumps to latest). Remap with `keybinds.search` |
| `z` | Expand logs to fill the terminal. `z` or `esc` exits |
| `w` | Cycle log wrap: clip, unwrap the selected row, or wrap every long line |
| `cmd+c` / `ctrl+shift+c` | Copy visible logs. Remap with `keybinds.copy` |
| `ctrl+=` / `ctrl+-` / `ctrl+0` | Display size (padding/row height, not the terminal font) |
| `ctrl+c` `ctrl+c` | Interrupt only — twice to quit. Copy is never `ctrl+c` on Linux/Windows |
| Mouse | Click nav, click a service, scroll logs (toggle in Settings) |

The status bar only lists keys that work **on the current screen**. On a terminal shorter than 20 rows the idle command bar hides; `/` still opens the command overlay.

## Nav tabs (11)

1. dashboard · 2. services · 3. logs · 4. identity · 5. credentials · 6. proxy · 7. doctor · 8. config · 9. profiles · 0. setup · then **settings** (no digit).

**MCP** is not a tab. Open it with `/mcp`, `/agent`, or Settings → **MCP → Settings page**.

## Screens

- **Dashboard** — services, identity, proxy, live log tail
- **Services** — list plus a live inspector: status chips, two-column facts, then a scrollable env pane. Narrow terminals stack the panes. `enter` opens the full detail screen
- **Service detail** — same inspector; env pane is focused so `j`/`k` scroll. `/reveal` shows secrets. `n`/`x`/`R`/`l`
- **Logs** — see [Logs](logs.md)
- **Identity** — user, project, source, ADC, gcloud, configured SAs, impersonation AVAILABLE/UNAVAILABLE, IAP (no tokens)
- **Credentials** — store backend and entry names only. Tokens stay in the OS keychain or `~/.devctl/credentials`
- **Proxy** — status + routes; `n` start / `x` stop
- **Doctor** — re-runs on every visit; ✓ / ! / ✗ with hints. `enter` on a busy port asks to stop that process; `r` reruns
- **Config** — merged view. `v` / `/buffer` opens a validate/save overlay on `cfg.configPath` (invalid YAML is not written; `esc` discards). `e` / `/edit` still opens `$EDITOR` / `DEVCTL_EDITOR`. `/reload` re-reads after an external edit
- **Profiles** — members; `enter` selects and offers start
- **Setup** — onboarding checklist. First-run with no config still opens here
- **Settings** — grouped prefs: theme, display size, mouse, leader timeout, **MCP settings page**, about, reset. `←`/`→` writes the highlighted cycle or toggles mouse. Reset asks before restoring defaults. Saves to `~/.devctl/tui.json` unless `DEVCTL_TUI_CONFIG` is set
- **MCP** — Listen `[ ON ]` / `[ OFF ]`, port stepper `‹ N ›`, per-agent **Copy JSON** / **Copy TOML**. Off by default. See [MCP](mcp.md)

`/reveal` toggles secret env values for this session only. The header shows `secrets shown`.

## Slash commands

```text
/start [service…]     start selection, args, or the current profile
/stop [service…]
/restart
/logs /services /auth /credentials /proxy /mcp /doctor /config /profiles /setup
/dashboard            return home
/themes [name]        picker with live preview; enter saves to ~/.devctl/tui.json
/settings             theme, mouse, display size, MCP page
/filter               toggle ERROR+
/pause                freeze the live log stream
/reveal               show or hide secret env values
/wrap                 cycle log wrap (selected / all / clip)
/copy                 copy visible logs to the clipboard
/export [path]        write filtered logs to ~/.devctl/exports (or the given path)
/exports              open the export folder
/regex /since /until /history /edit /buffer
/clear
/refresh
/reload               reload .devctl
/version
/exit /quit /q
```

Aliases include `/up`, `/down`, `/identity`, `/creds`, `/agent`, `/init`, `/home`, `/prefs`.

## Leader key

Default leader is `ctrl+x` (2 second timeout). Then:

```text
n start    x stop    R restart    s services    l logs
a auth     p proxy   d doctor     c config      o profiles
t themes   e export  r refresh    i setup       h dashboard
q quit     z fullscreen
```

Override in `tui.json` (`keybinds`) or `DEVCTL_TUI_CONFIG`.

## Layout

- **Header** — `devctl` plus version, project, profile, `running N/M`, proxy chip, MCP chip when running, ADC chip
- **Nav** — current tab highlighted
- **Body** — dashboard or a focused screen
- **Command line** — real OpenTUI input for `/` and palette filter
- **Status bar** — live/paused, last human result, contextual keys

Status is never color-only: `✓` healthy, `●` running, `!` warning, `✗` failed, `○` stopped.

## Themes

`/themes` opens a picker with live preview. Built-ins:

- Product: `devctl` (default), `ember`
- Common dark: `tokyonight`, `catppuccin`, `nord`, `gruvbox`, `kanagawa`, `dracula`, `onedark`, `monokai`, `rose-pine`, `everforest`, `github-dark`, `iceberg`, `ayu-dark`, `oxocarbon`, `night-owl`
- Light: `catppuccin-latte`, `solarized-light`
- Other: `solarized-dark`, `terminal` (black + VGA ANSI chrome; aliases `ansi`, `xterm`, `console`), `system` (follows macOS `AppleInterfaceStyle` / `COLORFGBG`; light uses Solarized Light)

Aliases: `mocha` → Catppuccin Mocha, `latte`, `one-dark`, `solarized` (dark), `rosepine`, `github`, `ayu`, `night owl`.

MCP agent chips use brand colors (Claude terracotta, Cursor blue, Kilo gold, Codex green) with light/dark variants.

## Related

- [Logs](logs.md)
- [MCP](mcp.md)
- [Building from source](typescript.md)
- [CLI](cli.md)
