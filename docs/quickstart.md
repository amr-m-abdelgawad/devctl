# Quick start

From a repository that should be orchestrated:

```bash
cd your-repo
devctl setup
gcloud auth application-default login   # only if you need Google Cloud
devctl doctor
devctl
```

`devctl setup` is a 9-step CLI wizard (repo root, project name, Google project, optional ADC login, optional SA email, optional IAP audience, proxy port, default profile, then doctor). If `.devctl/config.yaml` is missing it writes a starter file.

With no config, the TUI opens **setup** instead of exiting: Enter writes a starter config, Esc leaves.

## In the TUI

1. Press `o` to pick a profile (if you defined any).
2. On an empty dashboard, `enter` starts the default profile (first profile name alphabetically) after a plan overlay.
3. `n` starts the highlighted row or the space-selected set; `x` stops; `R` restarts.
4. `l` opens centralized logs. Identity is `a`. Credentials (never raw tokens) are the **credentials** tab.

See [TUI](tui.md) for every screen and key.

## CLI equivalent

```bash
devctl start --profile backend
devctl status
devctl logs invoices-api
devctl attach
devctl down
```

`devctl start` with no profile and no service names starts the active session profile, or the first configured profile. Pass `--profile` or explicit names to stay narrower. With no profiles, start fails instead of launching every service. It always leaves the daemon running after it exits — `--detach` is deprecated and no longer needed for that.

`devctl attach` only dials an existing supervisor. If nothing is listening, start with `devctl start` first. `devctl down` stops the daemon when you are done (add `--keep-services` to leave services running).

## Try the demo

```bash
cd examples/demo-platform
bun run ../../app/src/bin.ts
```

No Google Cloud. Profiles: `minimal`, `backend`, `full`. Details: [demo platform](../examples/demo-platform/README.md).

## Related

- [Installation](installation.md)
- [Configuration](configuration.md)
- [Developer setup](developer-setup.md)
- [Doctor](doctor.md)
