# Tests and CI

> **Experimental.** `devctl test`, `devctl bundle` and `start --wait` may change without a deprecation period. See [Experimental features](roadmap.md#experimental-features).

The configuration that runs your dev stack also runs your integration tests, on a laptop or in CI, with no separate compose file. `devctl test` brings up a throwaway stack, waits until it is healthy, runs your tests against it, saves evidence if they fail, and tears everything down.

```bash
# run a command against the stack
devctl test -- pytest -q tests/integration

# or a task from the config
devctl test integration

# a profile instead of every service
devctl test --profile backend --timeout 2m -- npm test
```

## `devctl start --wait`

The building block. `--wait` blocks until every service the start asked for is ready:

```bash
devctl start --profile backend --wait --timeout 2m
```

A service is **ready** when it is running and, if it has a [health check](services.md), healthy. A service without a health check counts as ready as soon as it runs. devctl has nothing else to wait on, so give a service a `health` block when "it is listening" matters.

| Outcome | Exit code |
|---------|-----------|
| Every service ready | 0 |
| A service failed to start, or is blocked | 5 |
| `--timeout` ran out (default 5m); the message names the services still not ready and their state | 6 |

`--timeout` takes `90s`, `2m`, `500ms`, `1h` or a number of seconds.

## `devctl test`

```text
devctl test [--profile <name> | --services a,b] [--timeout 5m] [--env-from <service>]
            [--artifacts devctl-artifacts] [--keep] (<task> | -- <command>...)
```

1. **A throwaway stack.** The run is a [named instance](parallel-stacks.md#named-instances), `test-<random>`, with its own port slot, state, containers and volumes, so it never collides with your dev stack or another CI job on the same machine. Pass `--instance <name>` (before `test`) to choose the name.
2. **Start and wait.** With `--profile` or `--services`, those start (with their dependencies). With neither, every service starts. Then it waits as `start --wait` does.
3. **Run the tests.**
   - A task from the config runs as `devctl run` would. Its output is printed when it ends.
   - A command after `--` runs in the foreground with your environment, so its output streams live. On top of your environment it gets where the stack is:
     - `DEVCTL_<SERVICE>_<PORT>_PORT` for every running service port (`DEVCTL_API_HTTP_PORT`, `DEVCTL_DB_MAIN_DB_PORT`: names uppercased, anything but letters and digits becomes `_`),
     - `DEVCTL_PROXY_URL` while the proxy is up,
     - `DEVCTL_INSTANCE`.
     Ports move with the stack's slot, so read them from these instead of hardcoding them. `--env-from <service>` adds that service's fully resolved environment as well, the same one `devctl exec <service>` uses.
4. **On failure, the bundle.** If the stack or the tests fail, a [bundle](#the-bundle) is written to `--artifacts` (default `./devctl-artifacts`).
5. **Tear down.** Services, containers and the supervisor stop, and the port slot is freed. `--keep` leaves the stack running instead, and prints how to stop it. Ctrl-C reaches the test command and still tears down.
6. **Exit** with the test command's code, or 5 or 6 when the stack itself failed.

## The bundle

`devctl bundle` writes the same evidence on demand, for a bug report:

```bash
devctl bundle --since 10m --output devctl-bundle.tgz   # or a directory
```

| File | Contents |
|------|----------|
| `status.json` | The status snapshot: services, ports, health, proxy, instance. The MCP token is removed. |
| `logs.ndjson` | Log records, newest 5000 (`--since` limits them to a window) |
| `traces.json` | Span trees with their logs, for up to 20 failed requests (5xx proxied requests and error logs) |
| `traffic.json` | Up to 200 captured proxy hops, without bodies |
| `doctor.json` | `devctl doctor --json` |
| `config-diff.json` | `devctl config diff --json`: effective values and where each came from |
| `bootstrap.log` | The supervisor's startup output |
| `versions.txt` | devctl, Bun, platform, instance |
| `errors.txt` | Any part that could not be collected (for example, no supervisor running) |

Every file is redacted, whatever `secrets.redact` says. Keys that name secrets are masked, and every string goes through the same detector as logs and traffic, including your `secrets.extra_markers` and `extra_patterns`. The bundle never reads `.devctl/secrets.env`, keychain values or decrypted SOPS output. Still, look through it before you attach it somewhere public.

## GitHub Actions

Install devctl from npm, run `devctl test`, and upload the bundle when the job fails:

```yaml
name: integration
on: [push, pull_request]

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install --global @amr-m-abdelgawad/devctl
      # Install what your services need (uv sync, npm ci, ...) here.
      - run: devctl test --timeout 5m -- npm run test:integration
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: devctl-artifacts
          path: devctl-artifacts
```

Parallel jobs on one runner each get their own instance and ports, so nothing needs to be serialized.

## Related

- [Parallel stacks](parallel-stacks.md)
- [Services and health checks](services.md)
- [CLI](cli.md)
- [Troubleshooting](troubleshooting.md)
