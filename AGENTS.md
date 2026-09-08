# Agents

When asked to onboard this repository to devctl, or to add or fix `.devctl/config.yaml` (including the demo under `examples/demo-platform/.devctl/`), follow `skills/devctl-onboard/SKILL.md` and its `references/` files. Validate with `devctl config validate` before reporting done.

Do not author `.devctl` YAML from the JSON Schema alone — `skills/devctl-onboard/references/authoring.md` carries the rules the loader rejects on and the schema does not state.

Contributing to this application itself: [CONTRIBUTING.md](CONTRIBUTING.md), [docs/typescript.md](docs/typescript.md), and [docs/architecture.md](docs/architecture.md). Follow the hexagonal layering rules in `.cursor/rules/architecture.mdc`. Run `cd app && bun run check:architecture` after structural changes.
