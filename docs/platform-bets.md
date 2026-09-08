# Platform bets (Phase 5)

These are separate products. Do not start them until Phases 1–3 of the product-gaps roadmap are in daily use. Each item needs its own scoped design.

| Item | Why it is late | Honest constraint |
|------|----------------|-------------------|
| Worker inside `bun build --compile` | Binaries already degrade to in-process | Needs a Bun embedding incantation that actually resolves at runtime; fallback stays |
| Structured-clone benchmark / coalesce stats echo | Measure, not defect | Source/npm only |
| Remote / SSH / Dev Container supervisor | Breaks “loopback + one socket per checkout” | New process model, auth on RPC |
| Multi-repo TUI | Two checkouts are two daemons by design | Picker that attaches to another `repoID` |
| K8s / Skaffold import | Cluster objects have no local equivalent | Keep discovery hints only unless we invent a tiny subset |
| Container `build`, networks, limits, `--workdir` | Compose parity | Schema + `containers.ts` only; no k8s |
| OIDC browser / device / refresh persistence | Plugin is client-credentials by design | New plugin, not core Google |
| OIDC as **route** auth | Proxy auth is `none` / `iap` / `service_account` | New proxy adapter path |
| Non-Google SSO in core | Violates “Google is an adapter” if it lands in domain | Plugin only |
| Windows named-pipe DACL | Bun does not expose DACL | Document until Bun can; optional RPC token is a bigger threat-model change (Unix also trusts anyone who can open the socket) |
| Apple notarization / Authenticode | Release/legal, not app code | Signing pipeline in `.github` |
| Custom TUI layouts, crash bell, mouse drag-select | Chrome, not orchestration | After parity |
| Workflow DAG beyond tasks + start waves | Tasks already exist | Only if `/run` pickers prove insufficient |

Interactive `gcloud` login stays a local TTY flow. MCP never owns a browser or a login TTY.

## Related

- [Architecture](architecture.md)
- [Plugins](plugins.md)
- [MCP](mcp.md)
