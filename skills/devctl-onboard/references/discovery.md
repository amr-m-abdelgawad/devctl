# Discovery: repository signal → devctl service

How to turn what a repository contains into the service list you draft from.
Read the signals in roughly this order — the earlier ones describe *how the
repo is actually run*, the later ones describe *where it is deployed*.

Throughout: a signal produces a **devctl service** only when the repo contains
runnable source and a start command for it. Everything else is either an
environment key, a proxy upstream, or context.

---

## 1. Task runners and process managers (highest signal)

These already encode "the commands a developer runs", which is exactly what a
devctl service is.

### docker-compose

`docker-compose.yml` / `compose.yaml` is the single best source. Map it, do not
copy it:

| Compose | devctl |
|---|---|
| `services.<name>` | `services.<name>` (same key) |
| `command` / image entrypoint | `command` — but see below |
| `ports: ["8000:8000"]` | `ports: { http: 8000 }` (the **host** side) |
| `depends_on` | `dependencies` |
| `environment` | `environment` vars / `defaults` |
| `env_file` | `environment.sources: [dotenv]` at the top level |
| `healthcheck.test` | `health: { type: command, command: [...] }`, or better, an `http` check if the container exposes one |
| `working_dir` / `build.context` | `working_dir` (relative to repo root) |

The trap: compose runs **containers**, devctl runs **host processes**. A
compose service whose only definition is `image: postgres:16` has no local
source and no host command — it is not a devctl service. Either leave it out
and note that the developer starts it separately, or keep it as an explicit
container command (`docker run …`) if the team genuinely wants devctl to own
it. Say which you chose.

### Procfile

Nearly a direct translation — one line, one service:

```
web: bundle exec puma -p 3000    →  services.web.command, ports.http: 3000
worker: bundle exec sidekiq      →  services.worker.command
```

### Makefile / Taskfile / justfile

Look for targets named `dev`, `run`, `serve`, `start`, `watch`. These usually
contain the real command. Beware targets that are pipelines — a command
containing `|`, `&&`, `;`, `>` or `&` needs `shell: true` in devctl.

### Foreman / overmind / honcho / air / nodemon configs

Same shape as Procfile; read them for the command and the port.

---

## 2. Per-language project files

Scan to depth 3, excluding `node_modules`, `.venv`, `vendor`, `target`, `dist`.
Each hit is a candidate service; its directory becomes `working_dir`.

### Node / Bun / Deno — `package.json`

- `scripts.dev` → the command. Prefer the repo's own package manager: `bun run
  dev`, `npm run dev`, `pnpm dev`. Check for a lockfile to pick correctly
  (`bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn).
- Port: look in `vite.config.*` (`server.port`), `next.config.*`, an explicit
  `--port` flag, or `PORT` in `.env`.
- Vite/Next dev servers can be slow to first respond — give them
  `startup.timeout_seconds: 45` rather than the default.

### Python — `pyproject.toml`, `requirements.txt`, `manage.py`

- FastAPI/Starlette: `uvicorn app.main:app --port 8000 --reload`
- Django: `python manage.py runserver 0.0.0.0:8000` (rewrite the bind to
  `127.0.0.1` for local use)
- Flask: `flask --app app run --port 5000`
- A bare `main.py` with `if __name__ == "__main__"` → `python3 main.py`
- Celery workers: `celery -A app worker` — no port, use `type: process` health.

### Go — `go.mod`

`go run ./cmd/<name>` or `air` when `.air.toml` is present. Port usually in a
`flag.String("addr", ":8080", …)` or read from env.

### Rust — `Cargo.toml`

`cargo run --bin <name>`, or `cargo watch -x run` when the dev tooling has it.

### JVM — `pom.xml`, `build.gradle`

`./mvnw spring-boot:run`, `./gradlew bootRun`. Port from
`application.properties` / `application.yml` (`server.port`).

### Ruby — `Gemfile`

`bin/rails server -p 3000`, or read the Procfile.

---

## 3. Environment files

Collect **key names**, never values.

```bash
# names only
grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' .env .env.* */.env 2>/dev/null | tr -d '=' | sort -u
```

devctl's `dotenv` source already reads, in order: repo root then the service's
`working_dir`, each as `.env`, `.env.development`, `.env.local`,
`.env.<profile>` — later wins. So:

- Add `environment.sources: [dotenv]` once, at the top level.
- Do **not** re-declare dotenv keys as service `environment` vars; that
  duplicates the value into YAML for no benefit.
- Do list keys the service genuinely cannot start without under
  `environment.required` — that turns a confusing runtime crash into a clear
  startup error.
- `.env.example` / `.env.sample` is the best source for *which* keys exist, and
  is safe to read in full — it holds placeholders. But devctl does **not** read
  it: the dotenv source only loads `.env`, `.env.development`, `.env.local` and
  `.env.<profile>`. A key that exists only in the example file is unset at
  start, so if you mark it `required`, say in your report that the user must
  create the real `.env` first. See the SKILL's secrets section.

Cross-service URLs found in `.env` (`API_URL=http://localhost:8000`) should be
rewritten as references in the config so they survive a port change:
`API_URL: http://127.0.0.1:${services.api.ports.http}`.

---

## 4. Kubernetes / Helm / Skaffold

Deployment descriptors, like Terraform — infer, do not transcribe.

- `Deployment.spec.containers[].ports.containerPort` → a sensible local port
- `env` / `envFrom.configMapRef` → env key names
- `envFrom.secretRef` → secret names, values never
- `livenessProbe.httpGet.path` → your `health.url` path
- `skaffold.yaml` `build.artifacts[].context` → candidate `working_dir`s, and
  its `deploy` section tells you what actually runs together

A Deployment for an image the repo does not build is not a local service.

---

## 5. Terraform

The direction matters: Terraform describes deployed infrastructure; devctl runs
local processes. **A Terraform resource is never a devctl service on its own.**

### What to extract

```bash
grep -rhoE 'resource "google_[a-z_]+"' --include='*.tf' . | sort -u
```

| Resource | Contributes |
|---|---|
| `provider "google"` / `var.project_id` / `var.region` | `google.project_id`, `google.region` |
| `google_service_account` | candidate `identity.service_account` (a service that impersonates it locally) or a route's `auth.identity.service_account` |
| `google_iap_*`, `google_iap_client`, IAP brand | route `auth.type: iap`; the OAuth client ID or resource name is the `audience` |
| `google_secret_manager_secret` | a key under `environment.secrets`, mapped to `projects/<p>/secrets/<name>`; add `secret_manager` to `environment.sources` |
| `google_cloud_run_v2_service`, `google_compute_backend_service` | if the repo builds it → the local service it corresponds to; if not → a proxy route `upstream.url` |
| `google_sql_database_instance`, Pub/Sub topics, GCS buckets | env keys the local service needs; no devctl object of their own |
| `google_project_iam_member` on a SA | tells you which SA a service is *meant* to run as — good evidence for `identity` |

### The judgement call

For each Cloud Run / GKE workload in Terraform, ask: **does this repo contain
the source and a way to start it?**

- Yes → it is a devctl service. Terraform tells you its identity and which
  secrets it reads.
- No → it is a dependency your local services call. If it needs injected auth
  (IAP, impersonation), give it a **proxy route** so local callers hit
  `127.0.0.1:<proxy>` and devctl attaches the credential. If it needs no auth,
  it is just a URL in the environment.

### Placeholders, not guesses

Service-account emails and IAP audiences are exact strings that fail obscurely
when wrong. If Terraform uses interpolation you cannot resolve
(`"${var.prefix}-api@${var.project}.iam.gserviceaccount.com"`), write the
literal shape you *can* determine and flag it for the user, rather than
resolving the variables yourself and shipping a plausible fabrication.

---

## 6. CI configuration

`.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile` are a useful
cross-check: the `services:` block of a CI job usually lists the backing
services (Postgres, Redis) a developer also needs, and the test setup steps
often reveal the true start command and the env keys required.

---

## Assembling the draft

After the sweep, you should be able to fill this table for every candidate:

| name | working_dir | command | port | dependencies | health | required env |
|---|---|---|---|---|---|---|

Rules for turning that into YAML:

- **Ports must be globally unique.** When the repo does not pin them, assign a
  contiguous private band (`18000+`) or use `auto`.
- **Dependency edges must be acyclic**, and should reflect "cannot start
  usefully without", not "talks to".
- **Group repeated shape into a template** — same language and runner usually
  means the same `health` cadence, `logs` and `restart` policy.
- **Profiles**: at minimum a small one (one service plus its dependencies) and
  a full one. Remember that a bare `devctl start` falls back to the first
  configured profile, and the TUI's default is the first profile
  alphabetically — so name them with that in mind.
