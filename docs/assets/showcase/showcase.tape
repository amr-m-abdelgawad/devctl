Output "/tmp/devctl-show-frames/"

Set Shell "bash"
Set Width 2560
Set Height 1440
Set FontSize 28
Set FontFamily "Menlo"
Set Padding 32
Set Framerate 30
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Hide
Type@1ms "cd examples/demo-platform && DEVCTL_TUI_CONFIG=../../docs/assets/showcase/tui.json bun run ../../app/src/bin.ts"
Enter
Sleep 5s
Show

# Dashboard: service health, proxy, MCP, telemetry at a glance
Sleep 4s

# Logs screen with a live structured stream
Type "3"
Sleep 2s

# Live-filter the invoice fulfill pipeline
Type "f"
Type "fulfill pipeline"
Sleep 2s
Escape
Sleep 2s

# Open a log line's structured detail
Up
Up
Enter
Sleep 3s

# Jump into its distributed trace
Enter
Sleep 2s
Down
Sleep 1s
Down
Sleep 1s

# Open the selected span's correlated logs
Enter
Sleep 3s
Escape
Sleep 1s
Escape
Sleep 2s

# Proxy screen: routed traffic with identity and latency
Type "4"
Sleep 4s

# Back to the dashboard
Type "1"
Sleep 3s
