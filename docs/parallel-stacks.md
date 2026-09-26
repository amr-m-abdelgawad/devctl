# Parallel stacks

Run the same configuration in several checkouts at once, such as one git worktree per coding agent or a review branch next to your main checkout, without editing any ports.

```bash
# ~/src/app: the first checkout to start takes slot 0 and keeps the configured ports
devctl start --profile backend

# ~/src/app-review-42: a second checkout takes slot 1, every fixed port +100
devctl start --profile backend

devctl instances
# SLOT  OFFSET  CHECKOUT              PROXY  WEB    OTLP   STATUS
# 0     +0      /home/me/src/app            18080  18900  18418  running
# 1     +100    /home/me/src/app-review-42  18180  19000  18518  running
```

## Port slots

Each checkout that starts a supervisor takes a numbered **slot** from a registry in `~/.devctl/instances.json` (or `$DEVCTL_HOME/instances.json`). The lowest free slot wins. There are 9 slots, 0 through 8.

Slot 0 keeps every port exactly as configured. Slot N adds N × 100 to:

- every fixed service port (`ports: {http: 18001}` → `18101` in slot 1). `ports: auto` stays automatic. For a container service this is the published host port; the container-side port in `container.ports` does not change.
- the proxy (`proxy.listen`), the token endpoint (`proxy.token_endpoint`) and every gRPC route listener
- the OTLP receiver (`telemetry.otlp.listen`)
- the web console (`web.listen`)

The MCP server already derives its port per checkout (see [MCP](mcp.md)), so it is not shifted again.

Services follow their shifted ports without changes to the configuration:

- `SERVICE_PORT`, `<NAME>_PORT` and `${services.<name>.ports.<port>}` carry the shifted value, so a service that listens on its injected port just works.
- `${services.<name>.url}` and `${services.<name>.host}` use the instance's own proxy port.
- A health check `url` or `address` on a loopback host (`127.0.0.1`, `localhost`, `[::1]`) at one of the service's own fixed ports is shifted with it, so `url: http://127.0.0.1:18001/health` becomes `…:18101/health` in slot 1. A health check pointing anywhere else is left as written.

A service that ignores its injected port and binds a hardcoded one will still collide. Read the port from `SERVICE_PORT` (or `<NAME>_PORT`) instead.

`devctl status` shows `INSTANCE: slot 1 (ports +100)` when the checkout isn't in slot 0, and `devctl doctor` checks the shifted ports. Callback URLs registered with outside providers (OAuth redirects, webhooks) usually name fixed ports, so run the checkout they point at in slot 0.

## Keeping and freeing a slot

A slot stays with its checkout, keyed by path, until it is freed. Restarts, `devctl down --keep-services` and a supervisor crash all keep it, because the services may still be running on the slot's ports. A start that fails before the supervisor is up (an invalid configuration, say) gives back a slot it had just claimed.

- `devctl down`, which stops the services too, frees the slot.
- `devctl instances prune` stops the stack of every checkout whose directory no longer exists (a deleted worktree) and frees its slot. It keeps the slot, and exits non-zero, while anything of that stack is still running: a supervisor that didn't stop in time, or services a `down --keep-services` left behind. Stop those, then prune again.

If all 9 slots are taken, starting another checkout fails with `all 9 port slots are taken by other checkouts`. Run `devctl down` in a checkout you're done with, or prune deleted ones.

## Commands

```text
devctl instances [--json]   # slot, offset, checkout, proxy/web/OTLP ports, status
devctl instances prune      # stop and free the slots of deleted checkouts
```

`STATUS` is `running` (its supervisor answers), `stopped`, or `missing` (the checkout directory is gone, even if its stack is still up; `prune` stops it).

## Not covered yet

- Named instances in one checkout (`devctl start --instance <name>`).
- Instance-prefixed Docker named volumes and seeding a new instance's volume. Two checkouts that declare the same named volume still share it.
- Writing each worktree's MCP client snippet for its agent.

These are tracked in [#117](https://github.com/amr-m-abdelgawad/devctl/issues/117).
