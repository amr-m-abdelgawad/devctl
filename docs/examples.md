# Examples & recipes

Use the checked-in demo to try a complete session, then carry the relevant patterns into your own repository. These commands use the demo's real service and profile names; they assume a global [devctl installation](installation.md).

## Prepare the demo

Install Python 3 for the host services. The frontend additionally needs Bun; the data profile needs Docker. Clone the repository and enter the demo:

```bash
git clone https://github.com/amr-m-abdelgawad/devctl.git
cd devctl/examples/demo-platform
devctl config validate
devctl start --profile minimal
devctl status
```

The `minimal` profile starts identity, the invoices API, the LLM stub, and the telemetry generator. These host services need neither Google credentials nor Docker. The demo already enables the proxy (with body inspect on local hops), OTLP receiver, web console, and a `type: proxy` LLM source.

| Recipe | Profile or service | What you learn |
|---|---|---|
| [Frontend + API](#frontend-api) | `full` | Group an application and wire service URLs |
| [Background worker](#background-worker) | `backend` | Start dependencies and inspect worker output |
| [Database + task](#database-task) | `data`, `migrate` | Use a container and a transient command |
| [Distributed trace](#follow-a-distributed-trace) | `minimal` | Follow proxy traffic into spans and logs |
| [Traffic inspector and LLM stub](#traffic-inspector-and-llm-stub) | `minimal` | Capture HTTP bodies and stub OpenAI calls |
| [Authenticated proxy](#authenticated-proxy) | worker routes | Inject Google credentials for a configured upstream |

Doctor checks everything declared in the configuration, so it can report missing Docker or Google credentials even when your selected local profile does not use them. The worker's optional token-watch loop and authenticated routes require real Google setup; the checked-in cloud identifiers are examples.

## Frontend + API

With Bun installed, start the full profile:

```bash
devctl start --profile full
```

Open the billing app at [localhost:18003](http://127.0.0.1:18003). Its first start installs frontend dependencies if they are missing. This is the demo application's UI; the devctl management console runs separately on port 18900.

The [billing-console service](../examples/demo-platform/.devctl/services/billing-console.yaml) declares its startup command and working directory, depends on `invoices-api`, and wires `AUTH_URL` and `API_URL` to `${services.<name>.url}` so local overlays go through the proxy hub (`identity.local` / `invoices-api.local`). Vite rewrites those to `DEVCTL_PROXY_URL` plus a `Host` header so you do not need `/etc/hosts`.

For your repository, use its existing frontend command and actual environment variable names. Group the frontend and backend under a full profile while keeping a smaller backend profile for API-only work. See [Onboarding](onboarding.md).

## Background worker

```bash
devctl start --profile backend
devctl logs invoices-worker
devctl restart invoices-worker
```

The demo worker polls the invoices API and finalizes queued jobs. Its configuration shows how to order startup and supply upstream URLs. The optional token-watch loop also demonstrates token refresh; credential errors from that loop require the Google setup described in the [demo README](../examples/demo-platform/README.md).

Starting a named service expands its dependencies automatically. Restarting the worker restarts only that service. Stopping a shared dependency also stops its dependents, so use the narrowest service command that fits your task. See [Services](services.md#start-stop-restart).

## Database + task

With Docker running:

```bash
devctl start --profile data
devctl status
devctl run migrate
```

The [PostgreSQL definition](../examples/demo-platform/.devctl/services/postgres.yaml) uses `container.image`, named host/container ports, and a health check. It maps host port **18004** to PostgreSQL's container port **5432**. It lives in the separate `data` profile so the normal host-service profiles do not require Docker.

The demo `migrate` task starts PostgreSQL as a dependency and prints a confirmation message; it does not apply a real database schema. Replace that task command with your repository's migration tool. Tasks run to completion and do not become continuously running services. See [hooks and tasks](services.md#hooks-and-one-off-tasks).

## Follow a distributed trace

```bash
devctl start --profile minimal
devctl web start --print-url
```

Open the printed console link and go to Traces. The telemetry generator periodically runs an `invoice.fulfill` workflow through the proxy, invoices API, and identity service. Select a trace to inspect overlapping spans and correlated logs. Some generated traces intentionally include a failed `stripe.charge` span to demonstrate error investigation.

![Demo request waterfall spanning telemetry, proxy, invoices API, and identity](assets/manual/web-trace-waterfall.png)

To inspect the same evidence from the terminal:

```bash
devctl logs telemetry
devctl logs --source otlp
```

Copy a trace identifier from the console and pass it to `devctl logs --trace <trace-id>`. In your own application, deeper spans require instrumentation and an OTLP/HTTP exporter (JSON or protobuf). See [Telemetry](telemetry.md) and the [web console tour](web.md).

## Traffic inspector and LLM stub

The demo's local HTTP routes (`identity`, `invoices-api`, `billing-console`, `llm`) set `inspect.enabled`, and callers use hub URLs so those hops appear on the TUI proxy screen and web `#/traffic` with redacted bodies. `llm` is a stdlib OpenAI-compatible stub (not LiteLLM); a `type: proxy` source captures `/v1/chat/completions` and `/generations/v1alpha2` onto the LLM inspector. Telemetry generates both kinds of traffic while `minimal` is running.

```bash
devctl traffic
devctl llm
```

See [Proxy inspect](proxy.md#inspect-bodies) and [LLM inspector](llm.md#proxy-capture-source-type-proxy).

## Authenticated proxy

The demo includes three routes to the same worker upstream: service-account impersonation, user IAP, and IAP with impersonation. They are useful configuration references, but they require your actual Google project, account, permissions, and audience before you can exercise the intended credentials.

Start with the [demo's credential walkthrough](../examples/demo-platform/README.md#credential-iap-and-identity-patterns). Use [Authentication](authentication.md), [Impersonation](impersonation.md), and [IAP](iap.md) to choose the matching identity setup. Keep account identifiers consistent across routes and the worker's token-watch environment. Use [Doctor](doctor.md) to check the prerequisites before testing requests.

For a local proxy request that needs no Google authentication, use the demo's API route while `minimal` is running:

```bash
curl -i -H 'Host: invoices-api.local' http://127.0.0.1:18080/health
```

The Host header selects the route without requiring a hosts-file entry. See [Proxy](proxy.md) for matching and upstream configuration.

## Finish the session

```bash
devctl down
```

This stops the supervisor and managed services. To adapt a recipe, start with [Onboard your repository](onboarding.md), copy only the pieces your application uses, and run `devctl config validate` before starting it.
