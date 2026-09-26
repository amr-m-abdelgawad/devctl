# Parallel stacks

Run the same configuration in several checkouts at once, such as one git worktree per coding agent or a review branch next to your main checkout, without editing any ports. Each stack gets its own ports, listeners, containers, volumes and state. A checkout is one stack; a named instance adds more in the same checkout.

```bash
# ~/src/app: the first checkout to start takes slot 0 and keeps the configured ports
devctl start --profile backend

# ~/src/app-review-42: a second checkout takes slot 1, every fixed port +100
devctl start --profile backend

# ~/src/app again: a named instance, a third stack of the same checkout
devctl --instance ci-7 start --profile backend

devctl instances
# SLOT  OFFSET  CHECKOUT                    INSTANCE  PROXY  WEB    OTLP   STATUS
# 0     +0      /home/me/src/app            -         18080  18900  18418  running
# 1     +100    /home/me/src/app-review-42  -         18180  19000  18518  running
# 2     +200    /home/me/src/app            ci-7      18280  19100  18618  running
```

## Port slots

Each stack that starts a supervisor takes a numbered **slot** from a registry in `~/.devctl/instances.json` (or `$DEVCTL_HOME/instances.json`). The lowest free slot wins. There are 9 slots, 0 through 8.

Slot 0 keeps every port exactly as configured. Slot N adds N × 100 to:

- every fixed service port (`ports: {http: 18001}` → `18101` in slot 1). `ports: auto` stays automatic. For a container service this is the published host port; the container-side port in `container.ports` does not change.
- the proxy (`proxy.listen`), the token endpoint (`proxy.token_endpoint`) and every gRPC route listener
- the OTLP receiver (`telemetry.otlp.listen`)
- the web console (`web.listen`)

The MCP server already derives its port per stack (see [MCP](mcp.md)), so it is not shifted again.

Services follow their shifted ports without changes to the configuration:

- `SERVICE_PORT`, `<NAME>_PORT` and `${services.<name>.ports.<port>}` carry the shifted value, so a service that listens on its injected port just works.
- `${services.<name>.url}` and `${services.<name>.host}` use the instance's own proxy port.
- A health check `url` or `address` on a loopback host (`127.0.0.1`, `localhost`, `[::1]`) at one of the service's own fixed ports is shifted with it, so `url: http://127.0.0.1:18001/health` becomes `…:18101/health` in slot 1. A health check pointing anywhere else is left as written.

A service that ignores its injected port and binds a hardcoded one will still collide. Read the port from `SERVICE_PORT` (or `<NAME>_PORT`) instead.

`devctl status` shows `INSTANCE: slot 1 (ports +100)` when the stack isn't in slot 0 (`INSTANCE: ci-7, slot 2 (ports +200)` for a named instance), and `devctl doctor` checks the shifted ports. Callback URLs registered with outside providers (OAuth redirects, webhooks) usually name fixed ports, so run the checkout they point at in slot 0.

## Keeping and freeing a slot

A slot stays with its stack, keyed by checkout path and instance name, until it is freed. Restarts, `devctl down --keep-services` and a supervisor crash all keep it, because the services may still be running on the slot's ports. A start that fails before the supervisor is up (an invalid configuration, say) gives back a slot it had just claimed.

- `devctl down`, which stops the services too, frees the slot. `devctl --instance ci-7 down` stops and frees only that instance.
- `devctl instances prune` stops every stack (named instances included) whose checkout directory no longer exists (a deleted worktree) and frees its slot. It keeps the slot, and exits non-zero, while anything of that stack is still running: a supervisor that didn't stop in time, or services a `down --keep-services` left behind. Stop those, then prune again.

If all 9 slots are taken, starting another stack fails with `all 9 port slots are taken by other stacks`. Run `devctl down` in a stack you're done with, or prune deleted checkouts.

## Named instances

`--instance <name>` runs another stack of the same checkout: a CI run next to your own stack, or a second copy for a before/after comparison. The name is 1 to 32 lowercase letters, digits, `-` or `_`.

```bash
devctl --instance ci-7 start --profile backend
devctl --instance ci-7 status
devctl --instance ci-7 down
```

`--instance` is a global flag, so it goes before the command, like `--config`. Setting `DEVCTL_INSTANCE=ci-7` in a shell (or an agent's environment) does the same for every command there. Everything that is per stack follows the name: port slot, supervisor, state and tokens, container names, named volumes, and the MCP port. Without a name you get the checkout's own stack, exactly as before.

## Volumes

A named volume in `container.volumes` belongs to one stack, so two checkouts never share a database. For `pgdata:/var/lib/postgresql/data`, the runtime sees `devctl-<id>-pgdata`, with the same `<id>` as the stack's container names. Bind mounts (`./data:/data`, absolute paths) and anonymous volumes pass through as written.

The first time a stack uses its volume, devctl fills it:

- from the volume named in `seed_from`, when the config sets one, and
- otherwise from the unprefixed volume (`pgdata`) if it exists, which is where a config that ran before this change kept its data.

When neither exists, the volume starts empty, as the image would create it. A seed runs once. Later starts reuse the stack's volume as it is.

```yaml
services:
  postgres:
    container:
      image: postgres:16
      volumes:
        - pgdata:/var/lib/postgresql/data
        - gocache:/root/.cache/go-build
      seed_from:
        pgdata: pgdata-fixture   # a volume you prepared with test data
      shared_volumes: [gocache]  # caches every stack may share, mounted as written
```

The copy runs `cp -a` in the service's own image with the source mounted read-only, so the image needs a `cp` (most do; a distroless one doesn't). Seed from a volume no running container is writing to: copying a live database's files gives an inconsistent copy. Stop the stack that uses the source first, or seed from a prepared volume.

Volumes outlive their stack. After deleting a worktree, remove its volumes with `docker volume ls --filter label=devctl.managed=true` and `docker volume rm`.

## Agents

Point each worktree's coding agent at its own stack by writing that stack's MCP config into the worktree:

```bash
devctl mcp --on --write claude   # .mcp.json
devctl mcp --write cursor        # .cursor/mcp.json
devctl mcp --write kilo          # kilo.jsonc
```

The file gets devctl's entry with this stack's URL and bearer token. Other servers in the file are kept. It holds a token, so keep it out of git, and write it again after `devctl mcp --rotate` or a token remint. Codex reads only `~/.codex/config.toml`, so for Codex use the snippet `devctl mcp` prints. See [MCP](mcp.md).

## Commands

```text
devctl instances [--json]         # slot, offset, checkout, instance, proxy/web/OTLP ports, status
devctl instances prune            # stop and free the slots of deleted checkouts
devctl --instance <name> <cmd>    # run a command against a named instance (or set DEVCTL_INSTANCE)
devctl mcp --write <client>       # write this stack's MCP config into the checkout
```

`STATUS` is `running` (its supervisor answers), `stopped`, or `missing` (the checkout directory is gone, even if its stack is still up; `prune` stops it).
