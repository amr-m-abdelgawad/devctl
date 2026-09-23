# Agents

When asked to onboard this repository to devctl, or to add or fix `.devctl/config.yaml` (including the demo under `examples/demo-platform/.devctl/`), follow `skills/devctl-onboard/SKILL.md` and its `references/` files. Validate with `devctl config validate` before reporting done.

Do not author `.devctl` YAML from the JSON Schema alone — `skills/devctl-onboard/references/authoring.md` carries the rules the loader rejects on and the schema does not state.

When asked to debug a service this devctl is already running — a crash, a health failure, a bad response, a missing environment value — follow `skills/devctl-debug/SKILL.md`. That skill reads status, logs, print-env, and proxy traffic. It does not rewrite `.devctl` YAML.

Contributing to this application itself: [CONTRIBUTING.md](CONTRIBUTING.md), [docs/internals/README.md](docs/internals/README.md), [docs/typescript.md](docs/typescript.md), and [docs/architecture.md](docs/architecture.md). Follow the hexagonal layering rules in `.cursor/rules/architecture.mdc`. Run `cd app && bun run check:architecture` after structural changes. After adding or removing modules, also run `bun run check:dead` and `bun run check:dup`.
