# Agent skills

Skills that teach a coding agent to work with devctl. They are plain Markdown
with no runtime dependency on devctl itself, so the same file works across the
four agents devctl's MCP server supports — Claude Code, Cursor, Codex and Kilo
Code.

| Skill | What it does |
|---|---|
| [`devctl-onboard`](devctl-onboard/SKILL.md) | Surveys a repository — services, docker-compose, Terraform, Kubernetes manifests, `.env` files, task runners — and authors a validated `.devctl/` configuration for it. |

`SKILL.md` is the single source of truth. This repository already points at it
from [`AGENTS.md`](../AGENTS.md), [`.cursor/rules/devctl-onboard.mdc`](../.cursor/rules/devctl-onboard.mdc),
and [`.kilocode/rules/devctl-onboard.md`](../.kilocode/rules/devctl-onboard.md).
The per-agent setup below is for installing the same pointer into **another**
repo you are onboarding.

## Claude Code

Skills are discovered from `~/.claude/skills/` (all projects) or
`.claude/skills/` (one project). Since onboarding runs *in the repo being
onboarded*, install it globally:

```bash
mkdir -p ~/.claude/skills && ln -sfn "$PWD/skills/devctl-onboard" ~/.claude/skills/devctl-onboard
```

Then invoke it by name — `/devctl-onboard` — or just describe the task
("onboard this repo to devctl"); the `description` in the frontmatter is what
Claude matches against.

## Cursor

Cursor reads `.cursor/rules/*.mdc` from the project being worked on. Create one
that points at the skill:

```bash
mkdir -p .cursor/rules
cat > .cursor/rules/devctl-onboard.mdc <<'EOF'
---
description: Author or fix a .devctl configuration for this repository.
globs: ".devctl/**,**/*.tf,docker-compose*.yml,.env*"
alwaysApply: false
---

Follow the procedure in `skills/devctl-onboard/SKILL.md` in this
checkout, including its `references/discovery.md` and `references/authoring.md`.

Do not author `.devctl` YAML from the JSON Schema alone — `references/authoring.md`
carries the rules the loader rejects on and the schema does not state.
EOF
```

## Codex

Codex reads `AGENTS.md` from the repository root. Add a pointer section:

```markdown
## devctl configuration

When asked to onboard this repository to devctl, or to add or fix
`.devctl/config.yaml`, follow `skills/devctl-onboard/SKILL.md` and its
`references/` files. Validate with `devctl config validate` before reporting
done.
```

## Kilo Code

Kilo reads custom rules from `.kilocode/rules/`. Same pointer as Cursor:

```bash
mkdir -p .kilocode/rules
printf 'When working on .devctl configuration, follow skills/devctl-onboard/SKILL.md and its references/ files.\n' \
  > .kilocode/rules/devctl-onboard.md
```

## Pairing with the devctl MCP server

The skill's verify phase uses devctl's MCP tools when they are available and
falls back to the CLI when they are not, so it works either way. To connect the
MCP server:

```bash
devctl mcp --on
```

```bash
devctl mcp
```

The second command prints the URL and ready-made config snippets for all four
agents. See [`docs/mcp.md`](../docs/mcp.md).

The server also serves this skill's own text as `get_setup_guide`, and
validates configuration as `validate_config` — including candidate text that
has not been written yet. So an agent connected to devctl's MCP server can do
the whole onboarding with no skill files installed at all; the per-agent setup
above is for driving it from the repository instead.

`devctl mcp --on` works in a repository that has no `.devctl` yet: the daemon
boots in setup mode so there is something for the agent to talk to before the
configuration exists.
