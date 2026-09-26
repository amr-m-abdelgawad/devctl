---
name: Doesn't fit my stack
about: You tried devctl on your stack and got stuck
labels: stack-feedback
---

Thanks for trying devctl outside the stack it grew up in. Where it breaks for you is exactly what the [roadmap](https://github.com/amr-m-abdelgawad/devctl/blob/main/docs/roadmap.md#feedback-from-other-stacks) needs.

**Your stack**

Languages and frameworks, how services run today (compose, scripts, Procfile, k8s), cloud and auth (AWS, Azure, GCP, none), one repo or several.

**How you onboarded**

The `devctl-onboard` skill with an agent, `devctl setup`, `config import`, or by hand. Did you get help beyond the docs?

**Your config attempt**

The `.devctl/config.yaml` you ended up with, or the part that failed. Remove secrets.

```yaml
```

**The first blocker**

The first thing that stopped you: the command, what you expected, what happened, and the error or `devctl config validate` output.

**Everything else that got in the way**

Anything after the first blocker, even if you worked around it.
