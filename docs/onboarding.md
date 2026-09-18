# Onboard your repository

Turn the commands you already run into a shared local development session. Start with one working service, verify it, then add dependencies and profiles. You need [devctl installed](installation.md) and your application's own runtimes and dependencies available.

## 1. Inventory what runs

Read the repository's development instructions, package scripts, task runners, and Compose files. Record the following for each service:

| Detail | What to record |
|---|---|
| Command | The exact command that already starts it locally |
| Working directory | Its directory relative to the repository root |
| Ports | The actual ports it listens on, unique across services |
| Dependencies | Services that must start before this one |
| Health | An existing health URL, TCP port, or command |
| Environment | Required variable names and where their values come from |

Keep a remote API as an upstream URL unless this repository also contains its runnable source. Use native container services for image-based dependencies such as PostgreSQL. See [Examples & recipes](examples.md) for working patterns.

## 2. Describe the first service

`devctl setup` can write a starter configuration. Review it against your inventory. Alternatively, create `.devctl/config.yaml` yourself.

This complete example describes the existing identity service in the [demo platform](../examples/demo-platform/README.md). It assumes the repository root contains `identity/main.py`, which serves `/health` on port 18001. For your own application, replace the command, directory, port, and health URL with the values you verified in step 1.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/schema/devctl.config.schema.json
version: 1
project:
  name: local-stack
services:
  identity:
    command: [python3, main.py]
    working_dir: identity
    ports:
      http: 18001
    health:
      type: http
      url: http://127.0.0.1:18001/health
profiles:
  minimal:
    services: [identity]
```

`working_dir` is relative to the directory containing `.devctl`, not `.devctl` itself. Prefer command argument lists. Commands containing shell operators such as `&&` need `shell: true`. A declared port must match what the application actually binds; declaring it does not rewrite the application's startup command.

## 3. Wire environment and dependencies

If your application uses dotenv files, add this top-level section to the existing configuration:

```yaml
environment:
  sources: [dotenv]
```

The dotenv source reads `.env`, `.env.development`, `.env.local`, and `.env.<profile>` from the repository root and service directory. It does **not** load `.env.example`: create your real `.env` from the example and fill in required values before starting. Keep secrets out of committed YAML.

For service-to-service addresses, reference named ports. For example, an API calling the identity service can use `AUTH_URL: http://127.0.0.1:${services.identity.ports.http}` in its service environment.

A string dependency such as `dependencies: [identity]` waits for the dependency process to start. When the caller must wait for readiness, use an object with `service: identity` and `condition: service_healthy`; the dependency must define a health check. See [Services](services.md#lifecycle) and [Environment](environment.md).

## 4. Grow into profiles and modular files

Keep a small profile for everyday work and a full profile for the complete application. Put optional containers in their own profile when the rest of the stack can run without them. Start profiles explicitly while setting up: `devctl start --profile minimal`.

As you add services, move their definitions into individual files:

```text
.devctl/
  config.yaml
  services/
    identity.yaml
    api.yaml
  profiles/
    minimal.yaml
    full.yaml
```

The filename is the service or profile key. A service file contains only its body (`command`, `working_dir`, and so on), without a `services:` wrapper. Keep `version: 1` in the main config and remove the old inline definition when moving it. See [Configuration](configuration.md) for merge rules and [Profiles](profiles.md) for grouping services.

## 5. Validate, start, and inspect

From your repository root:

```bash
devctl config validate
devctl config show
devctl doctor
devctl start --profile minimal
devctl status
devctl logs identity
```

Substitute your own profile and service names. Validation checks configuration structure and references; a successful start and a passing health check establish that the command and endpoint work. Doctor reports missing tools, occupied ports, and optional identity requirements.

If startup fails, read the failing service's logs. A missing required variable usually means the real dotenv file is absent or incomplete; a readiness timeout calls for checking the command, port, and health endpoint. During this initial setup, run `devctl down` before retrying a failed start so leftover processes do not obscure the original failure.

Once the service is healthy, use `devctl attach` for the TUI or `devctl web start --print-url` for the [web console](web.md). Run `devctl down` when you finish testing. Commit the shared configuration and document prerequisites for teammates.

## Let an agent help

The [devctl-onboard skill](../skills/devctl-onboard/SKILL.md) follows the same inventory, draft, validate, and runtime verification sequence. Follow [Agent skills](../skills/README.md) to install or reference it in your coding agent, then ask:

> Onboard this repository to devctl. Inventory the real startup commands, ports, dependencies, and environment variable names. Follow devctl-onboard, keep secrets out of YAML, validate the configuration, and verify the smallest local profile. Report any missing prerequisites.

You can also connect through MCP before a configuration exists:

```bash
devctl mcp --on
devctl mcp
```

The second command prints connection details. In setup mode, an agent can read `get_setup_guide`, validate candidate text with `validate_config`, write the configuration, then call `reload_config`. Service startup becomes available once a valid configuration is loaded. See [MCP](mcp.md) for client setup and tool controls.

## Related

- [Quick start](quickstart.md)
- [Examples & recipes](examples.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
