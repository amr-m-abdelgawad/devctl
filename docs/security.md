# Security

- Tokens never appear in normal TUI output, CLI status, or MCP tool results.
- Environment keys matching PASSWORD, SECRET, TOKEN, PRIVATE_KEY, CLIENT_SECRET, API_KEY, CREDENTIAL, ACCESS_KEY, AUTH_KEY (plus `secrets.extra_markers` / `extra_patterns`) render as `********`.
- `/reveal` is session-only and is shown in the header.
- Proxy logs redact `Authorization` headers.
- Proxy, token endpoint, and the optional MCP server bind `127.0.0.1` only. `0.0.0.0` is refused.
- MCP mutating tools require a session bearer token. Copied snippets include that header; `get_status` does not.
- Token endpoint requires a per-session secret injected only into managed processes, accepts loopback peers only, and returns `access_token` to those callers.
- Session lock and state live under `~/.devctl/state/<repo-hash>/` (`state.json`, `devctl.lock`, `devctl.sock`) so two checkouts do not share one global lock. A leftover `sessions/` path is migrated once. Stale locks from dead PIDs are replaced.
- String commands that contain shell metacharacters (`|`, `||`, `&&`, `;`, `>`, `>>`, `<`, `&`) fail validation unless `shell: true`.
- Child environments receive `DEVCTL_TOKEN_URL` and `DEVCTL_INTERNAL_TOKEN`, never raw access tokens.
- Commands are argv by default.
- Credential files use mode `0600` in a `0700` directory. OS keychain is preferred.
- Service-account private keys are never created or stored.
- Working directories are joined to the repository root. Configuration must not contain secrets — use overlays, keychain, or Secret Manager.

## Related

- [Authentication](authentication.md)
- [Proxy](proxy.md)
- [MCP](mcp.md)
- [Environment](environment.md)
