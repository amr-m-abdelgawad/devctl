# `devctl` — Local Development Orchestrator

## Complete Architecture & Implementation Specification

> **Status:** Implementation Specification  
> **Audience:** Coding / Agentic Development Agent  
> **Goal:** Build a production-quality CLI/TUI application for managing a complete multi-service local development environment.
>
> **Important:** Every feature described in this document is part of the required implementation. Do not remove, simplify away, or silently omit features because they appear complex. Where an implementation detail is not explicitly specified, choose a clean, maintainable implementation consistent with the architecture below.

---

# 1. Product Overview

`devctl` is a developer-focused local development orchestration CLI with a rich terminal UI.

Its purpose is to allow a developer to manage an entire multi-service development environment from one application.

The system must handle:

- Service discovery and configuration
- Starting and stopping services
- Restarting services
- Service dependencies
- Environment configuration
- Shared `.env`
- Per-service environment overrides
- Google Cloud authentication
- User identity
- Service-account impersonation
- IAP authentication
- Local authentication/proxy
- User-identity propagation
- Service-identity propagation
- Token lifecycle management
- Credential caching
- Health checks
- Service status
- Real-time logs
- Historical logs
- Log filtering/searching
- Multiple service log streams
- TUI navigation
- Environment diagnostics
- Google Cloud diagnostics
- Developer onboarding
- Configuration validation
- Extensible service definitions
- Extensible identity definitions
- Local development profiles
- Configuration-driven behavior
- Secure credential handling
- No hard-coded knowledge of individual services

The architecture must allow a new service to be added by modifying configuration rather than modifying the `devctl` source code.

---

# 2. Core Design Principle

The most important architectural principle is:

> `devctl` is a generic local-development platform, not an application-specific script.

The core application must not contain code such as:

```text
if service == "api":
    ...
elif service == "worker":
    ...
```

Instead, behavior must be driven by configuration.

The application should understand concepts such as:

```text
Service
Dependency
Environment
Process
Identity
Credential
Proxy Route
Health Check
Log Stream
Profile
```

but must not have hard-coded knowledge of individual company services.

---

# 3. High-Level Architecture

```text
                           ┌───────────────────────┐
                           │       Developer       │
                           └───────────┬───────────┘
                                       │
                                       ▼
                           ┌───────────────────────┐
                           │        devctl         │
                           │                       │
                           │       TUI / CLI       │
                           └───────────┬───────────┘
                                       │
             ┌─────────────────────────┼─────────────────────────┐
             │                         │                         │
             ▼                         ▼                         ▼
      Service Manager          Identity Manager            Proxy Manager
             │                         │                         │
             ▼                         ▼                         ▼
       Process Manager          Credential Manager        Local Proxy
             │                         │                         │
             │                         │                         │
             └───────────────┬─────────┴─────────────────────────┘
                             │
                             ▼
                    ┌───────────────────┐
                    │ Local Environment │
                    └─────────┬─────────┘
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
           API             Worker          Service C
             │                │                │
             └────────────────┼────────────────┘
                              │
                              ▼
                       Google Cloud / IAP
```

---

# 4. Application Layers

The implementation should be divided into clear modules.

Recommended architecture:

```text
devctl/
│
├── cmd/
│   ├── root
│   ├── start
│   ├── stop
│   ├── restart
│   ├── status
│   ├── logs
│   ├── doctor
│   ├── setup
│   ├── auth
│   ├── proxy
│   └── config
│
├── config/
│
├── services/
│
├── processes/
│
├── environment/
│
├── identity/
│
├── credentials/
│
├── google/
│
├── iap/
│
├── proxy/
│
├── logs/
│
├── health/
│
├── profiles/
│
├── tui/
│
├── cli/
│
├── storage/
│
└── main
```

Exact language/framework may be selected by the implementation agent, but the architectural separation must remain.

---

# 5. CLI + TUI

`devctl` must provide both CLI and TUI interfaces.

## CLI Mode

Examples:

```bash
devctl start
devctl start api
devctl start api worker

devctl stop
devctl stop api

devctl restart api

devctl status

devctl logs
devctl logs api

devctl doctor
devctl setup

devctl auth status
devctl auth login

devctl proxy status

devctl config validate
```

## TUI Mode

Running:

```bash
devctl
```

must launch the interactive TUI.

The TUI should follow a keyboard-first terminal UI.

---

# 6. Main TUI

The main screen should provide a global overview.

Conceptually:

```text
┌──────────────────────────────────────────────────────────────┐
│ devctl                                      local / dev      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ SERVICES                                                     │
│                                                              │
│ ● api        RUNNING     8000      healthy                   │
│ ● worker     RUNNING     8001      healthy                   │
│ ○ billing    STOPPED     8002                                │
│ ● frontend   RUNNING     3000      healthy                   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ IDENTITY                                                     │
│                                                              │
│ User: developer@company.com                                  │
│ Project: company-dev                                         │
│ Credentials: ✓                                               │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ PROXY                                                        │
│                                                              │
│ ● Running :8080                                              │
│ Routes: 4                                                    │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ LOGS                                                         │
│                                                              │
│ API       142 events                                         │
│ Worker     38 events                                         │
│ Billing     0 events                                         │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ [s] Services  [l] Logs  [a] Auth  [p] Proxy  [d] Doctor     │
│ [q] Quit                                                     │
└──────────────────────────────────────────────────────────────┘
```

---

# 7. TUI Navigation

Required screens:

```text
Dashboard
Services
Service Details
Logs
Log Details
Identity
Credentials
Proxy
Configuration
Doctor
Setup
Profiles
```

Navigation must support:

- Keyboard
- Arrow keys
- Shortcuts
- Enter
- Escape
- Ctrl+C
- Search
- Filtering
- Scrolling

The TUI must never require the user to manually manage terminals for individual services.

---

# 8. Service Manager

The Service Manager is responsible for the logical service model.

Each service must support:

```text
name
description
command
working directory
environment
dependencies
ports
health checks
logs
identity
proxy configuration
restart policy
startup policy
```

Example:

```yaml
services:

  api:
    command: ./run-api.sh
    working_dir: ./services/api

    ports:
      - 8000

    dependencies:
      - auth

    health:
      type: http
      url: http://localhost:8000/health

    identity:
      mode: user

  worker:
    command: ./run-worker.sh
    working_dir: ./services/worker

    dependencies:
      - api

    health:
      type: process

    identity:
      mode: service
      service_account: worker-dev@company-dev.iam.gserviceaccount.com
```

---

# 9. Service Lifecycle

Every service must have a lifecycle state.

Recommended states:

```text
UNKNOWN
STARTING
RUNNING
HEALTHY
UNHEALTHY
STOPPING
STOPPED
FAILED
RESTARTING
```

State transitions must be tracked.

Example:

```text
STOPPED
   ↓
STARTING
   ↓
RUNNING
   ↓
HEALTHY
```

Failure:

```text
STARTING
   ↓
FAILED
```

---

# 10. Process Manager

The Process Manager is responsible for actual OS processes.

Responsibilities:

- Spawn process
- Capture stdout
- Capture stderr
- Merge or separate streams
- Track PID
- Detect process exit
- Send signals
- Graceful shutdown
- Force kill
- Restart
- Capture exit code
- Monitor process lifetime

The implementation must work reliably with long-running processes.

---

# 11. Graceful Shutdown

When stopping a service:

```text
SIGTERM
    ↓
wait
    ↓
process exits
```

If it does not exit within configurable timeout:

```text
SIGKILL
```

The timeout must be configurable.

---

# 12. Dependencies

Services can depend on other services.

Example:

```yaml
services:

  api:
    dependencies:
      - auth
      - database

  worker:
    dependencies:
      - api
```

Starting:

```bash
devctl start worker
```

must resolve dependencies.

Execution:

```text
database
   ↓
auth
   ↓
api
   ↓
worker
```

Independent services may start in parallel.

The dependency graph must detect:

- Cycles
- Missing services
- Invalid references

Example:

```text
api → worker
worker → api
```

must be reported as a configuration error.

---

# 13. Profiles

The configuration must support development profiles.

Example:

```yaml
profiles:

  minimal:
    services:
      - api
      - auth

  backend:
    services:
      - api
      - auth
      - worker
      - billing

  full:
    services:
      - frontend
      - api
      - auth
      - worker
      - billing
      - analytics
```

Commands:

```bash
devctl start --profile backend
```

The TUI must also allow profile selection.

---

# 14. Shared Environment

`devctl` must provide a shared environment system.

There should be a global environment:

```text
.env
```

Example:

```dotenv
ENVIRONMENT=local
PROJECT_ID=company-dev
API_PORT=8000
AUTH_PORT=8001
LOG_LEVEL=DEBUG
```

Services automatically receive the appropriate environment.

---

# 15. Environment Precedence

Define deterministic precedence.

Recommended:

```text
1. Process/system environment
2. Profile environment
3. Global .env
4. Service .env
5. Service configuration overrides
6. Runtime-generated values
```

The exact precedence must be documented and implemented consistently.

---

# 16. Generated Environment

Some environment variables are generated dynamically.

Examples:

```text
SERVICE_PORT
SERVICE_HOST
DEVCTL_PROXY_URL
DEVCTL_SERVICE_NAME
DEVCTL_ENVIRONMENT
```

Identity-related runtime values must also be injected when required.

---

# 17. Environment References

Configuration should support references.

Example:

```yaml
services:

  api:
    environment:
      AUTH_URL: http://localhost:${services.auth.port}
```

The configuration engine should resolve references before process startup.

---

# 18. Environment Profiles

Support:

```text
.env
.env.local
.env.development
.env.<profile>
```

The configuration system must provide predictable merging behavior.

---

# 19. Identity Architecture

Identity is a first-class concept.

There are two fundamentally different identity modes:

```text
USER IDENTITY
SERVICE IDENTITY
```

They must not be conflated.

---

# 20. User Identity

The developer authenticates using their Google identity.

Preferred flow:

```text
Developer
    ↓
Google authentication
    ↓
Application Default Credentials / gcloud credentials
    ↓
devctl
```

The user's identity is used when a local service needs to access Google APIs as the developer.

The system should support:

```bash
devctl auth status
devctl auth login
devctl auth refresh
devctl auth logout
```

---

# 21. Service Identity

Some local services need to behave as a service account.

For example:

```text
worker
    ↓
worker-dev@company-dev.iam.gserviceaccount.com
```

The preferred implementation is:

> Service Account Impersonation.

Do not require developers to download long-lived service-account JSON keys.

Do not create private-key files for developers unless explicitly required by an exceptional legacy integration.

---

# 22. Service Account Impersonation

The desired architecture is:

```text
Developer Google Identity
          │
          │ IAM permission
          ▼
Service Account
          │
          ▼
Short-lived access token
```

The developer must have:

```text
roles/iam.serviceAccountTokenCreator
```

on the target service account.

This allows the developer to generate short-lived credentials for the service account.

---

# 23. Why Not Service Account Keys

Do not implement:

```text
download service-account.json
```

as the default solution.

Reasons:

- Long-lived secrets
- Credential leakage risk
- Difficult rotation
- Difficult revocation
- Security risk
- Poor developer experience
- Unnecessary when impersonation is available

The architecture must prefer short-lived credentials.

---

# 24. IAP Authentication

The system must support services protected by Google Cloud IAP.

Conceptually:

```text
Developer
   ↓
devctl identity manager
   ↓
Google credential
   ↓
IAP token
   ↓
Local service / proxy
   ↓
IAP protected backend
```

The IAP token manager must support:

- Token acquisition
- Token caching
- Expiration detection
- Refresh
- Concurrent refresh protection
- Error reporting
- Audience configuration

---

# 25. Token Manager

Create a generic token abstraction.

Example:

```text
Token
 ├── access_token
 ├── token_type
 ├── expires_at
 ├── audience
 └── identity
```

The Token Manager must expose functionality similar to:

```text
get_token()
refresh_token()
invalidate_token()
is_valid()
expires_soon()
```

---

# 26. Token Refresh

Tokens must never be blindly reused.

Before using a token:

```text
if expires_at - now < refresh_threshold:
    refresh
```

The refresh threshold must be configurable.

Example:

```yaml
auth:
  refresh_threshold_seconds: 300
```

---

# 27. Concurrent Token Requests

If multiple services request a token simultaneously:

```text
service A ─┐
service B ─┼──> Token Manager
service C ─┘
```

the system must avoid performing multiple unnecessary refreshes.

Use a per-token-key lock.

Example key:

```text
identity + audience + scope
```

Only one refresh should happen while other callers await the result.

---

# 28. Token Storage

Tokens are sensitive.

The implementation should prefer OS-native secure credential storage where available.

Possible backends:

```text
macOS Keychain
Windows Credential Manager
Linux Secret Service / Keyring
```

A filesystem fallback may exist only if necessary and must have restrictive permissions.

Never write plaintext credentials into the repository.

---

# 29. IAP Token Delivery Architecture

The system must support two approaches.

## Approach A — Token Endpoint

A local endpoint can expose token acquisition:

```text
GET /token
```

Services can request:

```text
http://localhost:<devctl-port>/token
```

This should never return credentials without authorization.

The local endpoint must be protected against arbitrary local processes where practical.

---

# 30. Preferred Proxy Architecture

For services that need to communicate with protected remote services, the preferred architecture is a local authentication-aware proxy.

```text
Local Service
     │
     │ HTTP
     ▼
devctl proxy
     │
     │ authenticated request
     ▼
Google Cloud / IAP
```

This avoids forcing every service to implement Google authentication logic.

---

# 31. Proxy Responsibilities

The proxy must be able to:

- Listen on configurable localhost port
- Route requests
- Match host/path rules
- Acquire credentials
- Refresh credentials
- Inject authentication
- Handle IAP
- Handle service-account impersonation
- Forward requests
- Preserve request body
- Preserve response body
- Preserve relevant headers
- Handle streaming responses where supported
- Produce structured logs
- Expose health status

---

# 32. Proxy Route Configuration

Example:

```yaml
proxy:

  enabled: true

  listen:
    host: 127.0.0.1
    port: 8080

  routes:

    - name: billing
      match:
        host: billing.local

      upstream:
        url: https://billing.example.com

      auth:
        type: iap
        identity: user

    - name: worker-api
      match:
        host: worker-api.local

      upstream:
        url: https://worker-api.example.com

      auth:
        type: service_account
        service_account: worker-dev@company-dev.iam.gserviceaccount.com
```

---

# 33. User Identity vs Service Identity

The proxy must explicitly define which identity is used per route.

Example:

```yaml
auth:
  type: iap
  identity: user
```

or:

```yaml
auth:
  type: iap
  identity: service_account
  service_account: backend-dev@company-dev.iam.gserviceaccount.com
```

Never silently substitute one identity for another.

The TUI must display the active identity.

---

# 34. Service-to-Service Communication

The architecture must support two models.

## Model A — User Identity

```text
service A
   ↓
devctl proxy
   ↓
user identity
   ↓
service B
```

This is appropriate when the developer is intentionally testing user-authorized behavior.

## Model B — Service Identity

```text
service A
   ↓
devctl proxy
   ↓
service-account impersonation
   ↓
service B
```

This is appropriate when the developer needs production-like service-to-service authorization.

The configuration decides which model is used.

---

# 35. Important Identity Rule

Do not assume that:

```text
local service A → local service B
```

must always use the developer's user identity.

Identity must be explicitly configured.

This avoids accidental authorization differences between local development and deployed environments.

---

# 36. Google Cloud Requirements

The Google Cloud portion must be treated as a first-class subsystem.

The setup must document and validate:

- Project
- APIs
- IAM permissions
- Service accounts
- IAP configuration
- Service-account impersonation
- OAuth / user authentication
- Developer onboarding

---

# 37. Required Google APIs

Depending on enabled features, the project may require APIs such as:

```text
IAM Credentials API
Cloud Resource Manager API
Identity-Aware Proxy API
```

The setup/doctor system must verify required APIs.

Do not blindly enable APIs without explicit configuration/permission.

---

# 38. Developer IAM

Developers who need service-account impersonation require:

```text
roles/iam.serviceAccountTokenCreator
```

on the relevant service account.

The permission should preferably be granted at the service-account level rather than broadly at the project level.

---

# 39. Developer Onboarding

The system must make developer setup as easy as possible.

Desired workflow:

```bash
devctl setup
```

The tool should:

1. Detect Google CLI
2. Detect authentication
3. Detect project
4. Validate IAM permissions
5. Validate required APIs
6. Validate service accounts
7. Validate IAP configuration
8. Validate local dependencies
9. Validate ports
10. Validate repository configuration
11. Produce actionable errors
12. Store only non-sensitive local configuration

---

# 40. Doctor Command

Implement:

```bash
devctl doctor
```

It must perform diagnostics.

Example output:

```text
devctl doctor

✓ Google CLI installed
✓ Google authentication available
✓ Project configured
✓ IAM Credentials API enabled
✓ Developer can impersonate worker-dev
✓ IAP configuration valid
✓ Node installed
✓ Python installed
✓ Port 8000 available
✓ Port 8080 available
✗ Billing dependency unavailable

1 issue found.
```

Errors must explain how to fix them.

---

# 41. Google Permission Diagnostics

The system must distinguish:

```text
Authentication failure
Authorization failure
Missing API
Missing IAM role
Wrong project
Wrong service account
IAP configuration problem
Expired credential
Network problem
```

Do not return generic:

```text
Authentication failed
```

when a more precise explanation is possible.

---

# 42. Easy Permission Distribution

Developer permissions should be manageable centrally.

The repository should include documented infrastructure/configuration for administrators to grant developers access.

Recommended approach:

```text
Google Group
    ↓
IAM binding
    ↓
Service Account Token Creator
    ↓
Developer group members
```

This avoids manually granting permissions to every individual developer.

Example conceptual setup:

```text
dev-developers@company.com
        │
        ▼
roles/iam.serviceAccountTokenCreator
        │
        ▼
worker-dev@company-dev.iam.gserviceaccount.com
```

The exact organization policy may vary.

`devctl` should not require administrator privileges from normal developers.

---

# 43. Admin vs Developer Responsibilities

Clearly separate:

## Administrator

Responsible for:

- Creating service accounts
- Granting IAM permissions
- Configuring IAP
- Enabling APIs
- Configuring groups
- Configuring cloud infrastructure

## Developer

Responsible for:

- Installing `devctl`
- Authenticating
- Running setup
- Selecting profile
- Starting services
- Inspecting logs
- Developing code

---

# 44. Configuration Repository

Configuration should be version-controlled where appropriate.

Recommended:

```text
.devctl/
│
├── config.yaml
├── services/
│   ├── api.yaml
│   ├── worker.yaml
│   └── billing.yaml
│
├── profiles/
│   ├── minimal.yaml
│   ├── backend.yaml
│   └── full.yaml
│
└── proxy/
    └── routes.yaml
```

The exact structure can be simplified, but configuration must remain modular.

---

# 45. Configuration Discovery

`devctl` should search for configuration in predictable locations.

Example:

```text
./.devctl/config.yaml
```

Then parent directories if appropriate.

Allow explicit override:

```bash
devctl --config ./custom/devctl.yaml
```

---

# 46. Configuration Validation

Implement:

```bash
devctl config validate
```

Validation must include:

- YAML/JSON syntax
- Required fields
- Unknown fields
- Service references
- Dependency cycles
- Duplicate ports
- Invalid commands
- Invalid identities
- Invalid proxy routes
- Environment references
- Profile references

---

# 47. Configuration Schema

Use a strongly typed configuration model.

Avoid passing arbitrary dictionaries throughout the application.

Example conceptual types:

```text
DevctlConfig
ServiceConfig
ProfileConfig
IdentityConfig
ProxyConfig
RouteConfig
HealthCheckConfig
EnvironmentConfig
LogConfig
```

---

# 48. Extensibility

Adding a service should require only:

```yaml
services:
  new-service:
    command: ./run.sh
    working_dir: ./new-service
```

and possibly:

```yaml
dependencies:
  - api
```

No source-code modification should be required.

---

# 49. Service Templates

Support reusable service templates.

Example:

```yaml
templates:

  python-service:
    health:
      type: http

    logs:
      stdout: true
      stderr: true
```

Then:

```yaml
services:

  api:
    extends: python-service
    command: python main.py
```

---

# 50. Log System

Logging is a major feature.

The user must have a dedicated log area where they can inspect all logs generated by managed services.

The system must capture:

```text
stdout
stderr
proxy logs
devctl logs
health-check events
authentication events
```

---

# 51. Log Aggregator

All process output must be sent into a centralized Log Manager.

Architecture:

```text
API stdout ──────┐
API stderr ──────┤
Worker stdout ───┤
Worker stderr ───┤
Proxy ───────────┤
Health checks ───┼──> Log Manager
devctl ──────────┘
                       │
                       ├── Memory buffer
                       ├── Persistent log
                       └── TUI
```

---

# 52. Structured Log Event

Every event should have metadata.

Example:

```json
{
  "timestamp": "2026-08-29T20:10:00Z",
  "service": "api",
  "source": "stdout",
  "level": "INFO",
  "message": "Server started",
  "pid": 12345
}
```

Fields:

```text
timestamp
service
source
level
message
pid
stream
request_id
identity
```

Not every field must always exist.

---

# 53. Log Levels

Support:

```text
TRACE
DEBUG
INFO
WARN
ERROR
FATAL
UNKNOWN
```

If the original service output does not contain a level, infer `UNKNOWN` or parse common log formats.

---

# 54. Log Storage

The system must maintain a bounded in-memory buffer.

Configuration:

```yaml
logs:
  max_memory_events: 50000
```

This prevents unbounded memory growth.

---

# 55. Persistent Logs

Optionally persist logs locally.

Recommended location:

```text
~/.devctl/logs/
```

Example:

```text
~/.devctl/logs/
    session-2026-08-29T20-00-00/
        api.log
        worker.log
        proxy.log
```

Retention must be configurable.

---

# 56. Log Sessions

Each invocation/session should have a session identifier.

Example:

```text
session: 2026-08-29T20-00-00Z-abc123
```

This allows historical debugging.

---

# 57. TUI Log Viewer

The log screen must support:

- All services
- Single service
- Multiple selected services
- Search
- Filtering
- Log level filter
- Time ordering
- Auto-scroll
- Pause
- Resume
- Clear
- Jump to latest
- Jump to errors
- Copy
- Expand event
- Toggle timestamps
- Toggle metadata

---

# 58. Log Screen

Conceptually:

```text
┌──────────────────────────────────────────────────────────────┐
│ LOGS                                      [LIVE] [PAUSED]    │
├──────────────────────────────────────────────────────────────┤
│ Filter: api,worker       Level: INFO+       Search:          │
├──────────────────────────────────────────────────────────────┤
│ 20:10:01 api     INFO   Server started                      │
│ 20:10:02 api     INFO   Connected to auth                   │
│ 20:10:03 worker  INFO   Worker initialized                  │
│ 20:10:05 api     WARN   Slow request                        │
│ 20:10:06 worker  ERROR  Failed to process message           │
│ 20:10:06 worker  ERROR  retrying                            │
│                                                              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ [f] filter [/] search [p] pause [e] errors [g] latest       │
└──────────────────────────────────────────────────────────────┘
```

---

# 59. Log Streaming

Logs must update in real time.

Do not poll the filesystem unnecessarily.

Preferred architecture:

```text
Process stdout
      ↓
async stream reader
      ↓
Log Manager
      ↓
event bus
      ↓
TUI
```

---

# 60. Event Bus

The system should have an internal event bus.

Events include:

```text
ServiceStarted
ServiceStopped
ServiceFailed
ServiceHealthChanged
LogReceived
TokenRefreshed
AuthenticationChanged
ProxyStarted
ProxyStopped
ProxyRequest
ConfigurationChanged
```

This prevents tightly coupling the TUI to the service manager.

---

# 61. Health Checks

Services may define health checks.

Supported types should include:

```text
HTTP
TCP
Process
Command
```

Example:

```yaml
health:
  type: http
  url: http://127.0.0.1:8000/health
  interval_seconds: 5
  timeout_seconds: 2
```

---

# 62. Health Status

Display:

```text
HEALTHY
UNHEALTHY
UNKNOWN
```

The TUI should show transitions.

---

# 63. Automatic Restart

Services may define restart behavior.

Example:

```yaml
restart:
  enabled: true
  max_retries: 3
  backoff_seconds: 2
```

Backoff should increase for repeated failures.

---

# 64. Port Management

Services may declare ports.

The system must detect:

- Port already in use
- Duplicate configured ports
- Invalid port numbers

Optionally support dynamic ports.

Example:

```yaml
ports:
  api: auto
```

If dynamic ports are supported, the selected port must be injected into the service environment.

---

# 65. Cross-Platform Support

The architecture should target:

```text
macOS
Linux
Windows
```

OS-specific process handling must be isolated behind abstractions.

Example:

```text
ProcessManager
    ├── UnixProcessManager
    └── WindowsProcessManager
```

---

# 66. Repository Awareness

`devctl` should understand the repository root.

It must not assume that the executable is always launched from the repository root.

Possible strategy:

```text
Search current directory
    ↓
Find .devctl
    ↓
Repository root
```

Allow explicit configuration.

---

# 67. Service Working Directories

A service's working directory should be resolved relative to repository root by default.

Example:

```yaml
working_dir: services/api
```

means:

```text
<repo-root>/services/api
```

---

# 68. Shell Commands

Commands must support:

```yaml
command: npm run dev
```

and:

```yaml
command:
  - npm
  - run
  - dev
```

Prefer structured arguments internally to reduce shell-injection issues.

Shell execution should be explicitly configured where required.

---

# 69. Environment Security

The TUI must never accidentally display secret values.

For example:

```dotenv
DATABASE_PASSWORD=...
```

must display as:

```text
DATABASE_PASSWORD=********
```

unless the developer explicitly requests reveal behavior.

---

# 70. Secret Detection

The system should identify likely secrets based on names such as:

```text
PASSWORD
SECRET
TOKEN
PRIVATE_KEY
CLIENT_SECRET
API_KEY
CREDENTIAL
```

Configuration may allow custom secret patterns.

---

# 71. Error Model

All subsystems should use typed errors.

Examples:

```text
ConfigurationError
ServiceNotFoundError
DependencyError
ProcessStartError
AuthenticationError
AuthorizationError
TokenError
ImpersonationError
IAPError
ProxyError
HealthCheckError
```

The CLI/TUI should convert them into human-readable messages.

---

# 72. Retry Policy

Retries must be explicit.

Authentication and network operations may retry.

Configuration errors must not retry.

Example:

```text
Invalid config
    → fail immediately

Network timeout
    → retry with backoff
```

---

# 73. Offline Mode

The local service manager should continue to function even if Google Cloud is unavailable.

For example:

```bash
devctl start api
```

should work even if authentication is currently unavailable, provided `api` does not require cloud authentication.

Cloud-dependent services should report the dependency failure clearly.

---

# 74. Authentication Dependency Graph

Identity requirements should participate in startup validation.

Example:

```text
worker
  ↓
service-account identity
  ↓
impersonation permission
```

If impersonation is unavailable:

```text
worker → FAILED TO START
```

while unrelated local services can still run.

---

# 75. Service Capability Model

Services may declare capabilities.

Example:

```yaml
capabilities:
  - local_http
  - google_api
  - iap
  - service_identity
```

This can be used by validation and the TUI.

---

# 76. Startup Planning

Before starting services, build a startup plan.

Example:

```text
Profile: backend

Plan:

1. auth
2. database
3. api
4. worker
5. billing
```

The TUI may display the plan before execution.

---

# 77. Parallel Startup

Independent services should start concurrently.

Example:

```text
          ┌── database
          │
auth ─────┼── cache
          │
          └── metrics
                │
                ▼
               api
```

`database`, `cache`, and `metrics` can start concurrently.

---

# 78. Shutdown Planning

Shutdown should reverse dependency order.

Example:

```text
worker
   ↓
api
   ↓
auth
```

Independent services may stop concurrently.

---

# 79. Session State

`devctl` should maintain local runtime state.

Example:

```text
~/.devctl/state/
```

Possible state:

```json
{
  "session_id": "...",
  "services": {
    "api": {
      "pid": 1234,
      "status": "running"
    }
  }
}
```

State must be resilient to crashes.

---

# 80. Stale Process Detection

If `devctl` crashes, the next invocation must detect stale processes.

Never assume a stored PID is still the same process.

Use additional identity information such as:

```text
PID
command
working directory
start time
```

before acting on a stale process.

---

# 81. Multiple devctl Instances

The system should prevent conflicting instances where required.

Use a lock:

```text
~/.devctl/devctl.lock
```

The lock must handle stale ownership.

---

# 82. TUI Service Actions

From the service screen, users must be able to:

```text
Start
Stop
Restart
View logs
View environment
View dependencies
View health
Open configuration
```

---

# 83. TUI Identity Screen

Display:

```text
Current User:
developer@company.com

Project:
company-dev

ADC:
AVAILABLE

Service Account Impersonation:
AVAILABLE

Configured Service Accounts:
✓ worker-dev
✓ billing-dev
✗ analytics-dev

IAP:
✓ Available
```

Do not expose tokens.

---

# 84. TUI Proxy Screen

Display:

```text
Proxy

Status: RUNNING
Address: 127.0.0.1:8080

Routes:

billing
  identity: user
  upstream: billing.example.com

worker-api
  identity: worker-dev
  upstream: worker-api.example.com
```

---

# 85. Proxy Request Logs

Proxy requests should be logged without secrets.

Example:

```text
20:12:00
GET /orders/123
route=billing
identity=user
status=200
duration=124ms
```

Never log:

```text
Authorization: Bearer ...
```

---

# 86. Request Correlation

Where possible, generate or propagate:

```text
X-Devctl-Request-ID
```

This identifier should appear in proxy logs and service logs when supported.

---

# 87. Configuration Hot Reload

The system should support configuration reload where safe.

Example:

```text
config changed
    ↓
validate
    ↓
reload
```

Changes that require service restart must be detected.

Example:

```text
Environment changed:
API_URL

→ api restart required
```

---

# 88. TUI Configuration Editor

The TUI should allow viewing configuration.

Editing may be supported if practical, but configuration must always remain representable as files and remain version-control friendly.

---

# 89. Setup Wizard

`devctl setup` should be interactive.

Steps:

```text
1. Repository
2. Environment
3. Google Project
4. Authentication
5. Service accounts
6. IAP
7. Ports
8. Profiles
9. Validation
```

The wizard should save only configuration that is safe to persist.

---

# 90. First Run Experience

Running:

```bash
devctl
```

on an unconfigured repository should detect missing configuration.

Example:

```text
No devctl configuration found.

Would you like to run setup?

[Enter] Setup
[Esc] Exit
```

---

# 91. CLI Output

CLI output should be machine-friendly when requested.

Support:

```bash
devctl status --json
devctl config validate --json
```

Example:

```json
{
  "services": {
    "api": {
      "status": "healthy"
    }
  }
}
```

---

# 92. TUI Architecture

The TUI must not directly control processes.

Use:

```text
TUI
 ↓
Application Controller
 ↓
Domain Services
 ↓
Managers
```

Not:

```text
TUI → subprocess.Popen(...)
```

---

# 93. TUI State

The TUI should subscribe to application state/events.

State includes:

```text
services
logs
identity
proxy
health
configuration
```

Updates should be event-driven.

---

# 94. Non-Blocking TUI

Long-running operations must not block the TUI.

Examples:

```text
starting service
refreshing token
health checking
proxy request
configuration validation
```

must execute asynchronously.

---

# 95. Keyboard Shortcuts

Suggested defaults:

```text
q       quit
s       services
l       logs
a       authentication
p       proxy
d       doctor
r       refresh
/       search
f       filter
enter   details
esc     back
space   select
ctrl+c  interrupt (twice to quit)
cmd+c   copy logs (macOS; ctrl+c elsewhere)
```

Shortcuts must be configurable where reasonable.

---

# 96. Log Search

Search must support substring matching.

Example:

```text
connection refused
```

Optional support:

```text
regex
```

must be clearly distinguished from normal search.

---

# 97. Log Filtering

Filters:

```text
service
level
source
time
search
```

Example:

```text
service=worker
level>=ERROR
```

---

# 98. Log Export

Support:

```bash
devctl logs export --service api --output api.log
```

The TUI should provide an export action if practical.

---

# 99. Crash Handling

Unexpected application crashes must not leave services in dangerous states.

The system should:

- Persist enough state to recover
- Detect orphaned processes
- Avoid killing unrelated processes
- Release locks
- Report recovery information

---

# 100. Testing Architecture

The system must have automated tests.

Minimum categories:

```text
Unit tests
Integration tests
Configuration tests
Process manager tests
Dependency graph tests
Token manager tests
Proxy tests
Log manager tests
TUI state tests
```

---

# 101. Unit Tests

Test independently:

```text
ConfigLoader
ConfigValidator
DependencyResolver
EnvironmentResolver
ProcessManager
TokenManager
IdentityManager
HealthManager
LogManager
ProxyRouter
```

---

# 102. Integration Tests

Integration tests should use local mock services.

Example:

```text
mock-service-a
mock-service-b
mock-IAP-server
mock-token-provider
```

Do not require production Google Cloud for normal tests.

---

# 103. Google Cloud Integration Tests

Provide optional integration tests that run only when explicitly enabled.

Example:

```bash
DEVCTL_GOOGLE_INTEGRATION_TESTS=1 pytest
```

These tests may verify:

- Service-account impersonation
- Token acquisition
- IAP behavior
- Permission failures

---

# 104. Security Testing

Test:

- Secret redaction
- Token non-leakage
- Proxy authentication
- Local endpoint access
- Path traversal
- Command injection
- Environment injection
- Unsafe config
- Credential file permissions

---

# 105. Command Injection Prevention

Configuration must not automatically interpret arbitrary configuration strings as shell code.

When shell execution is required:

```yaml
shell: true
```

should be explicit.

---

# 106. Local Token Endpoint Security

If a local token endpoint is implemented, it must be carefully secured.

Do not expose it on:

```text
0.0.0.0
```

by default.

Default:

```text
127.0.0.1
```

Tokens must never be returned based solely on arbitrary remote HTTP requests.

---

# 107. Proxy Security

Proxy defaults:

```text
listen_host: 127.0.0.1
```

Do not expose the proxy publicly unless explicitly configured.

---

# 108. Configuration Versioning

Configuration should include a version:

```yaml
version: 1
```

Future schema migrations must be possible.

---

# 109. Plugin Architecture

The architecture should allow future plugins.

Potential plugin types:

```text
Service Provider
Identity Provider
Token Provider
Proxy Middleware
Log Parser
Health Check
```

Plugins should not be required for the initial implementation, but the domain boundaries should make them possible.

---

# 110. Generic Token Provider

Implement an abstraction such as:

```text
TokenProvider
```

Possible implementations:

```text
GoogleUserTokenProvider
GoogleServiceAccountTokenProvider
IAPTokenProvider
StaticTokenProvider
```

The application should depend on the interface rather than Google-specific implementations.

---

# 111. Generic Identity Provider

Implement:

```text
IdentityProvider
```

Possible implementations:

```text
UserIdentityProvider
ServiceAccountIdentityProvider
```

---

# 112. Credential Manager

Responsibilities:

```text
discover credentials
validate credentials
cache credentials
refresh credentials
invalidate credentials
report status
```

It should not be coupled directly to the TUI.

---

# 113. Google Credential Flow

Preferred service-account flow:

```text
Developer
   │
   │ Google user credential
   ▼
Credential Manager
   │
   │ generateAccessToken
   ▼
IAM Credentials API
   │
   ▼
Short-lived service account token
```

The application must not generate or store service-account private keys.

---

# 114. IAP Flow

Conceptually:

```text
Service
   │
   ▼
devctl proxy
   │
   ▼
Identity Manager
   │
   ├── user credential
   │
   └── service-account impersonation
   │
   ▼
IAP authentication
   │
   ▼
Remote service
```

---

# 115. Token Audience

IAP tokens must use the correct audience.

Audience must be configurable:

```yaml
auth:
  type: iap
  audience: "..."
```

The system must validate that an audience is configured when required.

---

# 116. Identity Selection

A service may specify:

```yaml
identity:
  type: user
```

or:

```yaml
identity:
  type: service_account
  service_account: worker-dev@company-dev.iam.gserviceaccount.com
```

Proxy routes may independently specify identity.

---

# 117. Environment Injection for Identity

Services that require local credentials should receive only the minimum environment required.

Avoid exporting sensitive raw tokens when possible.

Prefer:

```text
proxy URL
credential helper
ADC-compatible mechanism
```

over injecting raw tokens into environment variables.

---

# 118. Local ADC Strategy

Where compatible with Google SDKs, the system should integrate with Application Default Credentials.

The implementation should avoid inventing a proprietary credential mechanism when Google SDKs already support the required flow.

---

# 119. Developer Experience

The final system should make the common workflow:

```bash
git clone ...
cd project

devctl setup

devctl
```

Then:

```text
select profile
select services
press start
```

The developer should not need to manually:

```text
open 5 terminals
export 20 environment variables
run gcloud commands
copy tokens
restart services
tail multiple logs
```

---

# 120. Typical Workflow

Example:

```text
Developer starts devctl
        ↓
Configuration discovered
        ↓
Environment loaded
        ↓
Google authentication checked
        ↓
Profile selected
        ↓
Dependency graph generated
        ↓
Startup plan generated
        ↓
Services launched
        ↓
Health checks start
        ↓
Logs stream into central Log Manager
        ↓
Proxy starts
        ↓
Identity manager becomes available
        ↓
Developer works
```

---

# 121. Typical Service-to-Cloud Request

```text
Local API
   │
   │ request to remote billing service
   ▼
devctl proxy
   │
   ├── determine route
   ├── determine identity
   ├── acquire token
   ├── refresh if needed
   ├── inject authentication
   ▼
IAP
   │
   ▼
Remote Billing Service
```

---

# 122. Typical Service-to-Service Request

User identity:

```text
API
 ↓
proxy
 ↓
developer identity
 ↓
remote service
```

Service identity:

```text
Worker
 ↓
proxy
 ↓
impersonate worker-dev
 ↓
remote service
```

---

# 123. No Hard-Coded Services

The application must not require recompilation to add:

```text
payments
search
analytics
notifications
```

Configuration should be enough.

---

# 124. No Hard-Coded Google Service Accounts

Do not write:

```text
worker-dev@...
billing-dev@...
```

into application source code.

These must come from configuration.

---

# 125. No Hard-Coded Ports

Ports must be configuration-driven.

---

# 126. No Hard-Coded Profiles

Profiles must be configuration-driven.

---

# 127. No Hard-Coded Environment Variables

The environment engine must support arbitrary configured variables.

---

# 128. Repository Configuration Example

A complete example could look like:

```yaml
version: 1

project:
  name: my-platform

google:
  project_id: company-dev

profiles:

  backend:
    services:
      - auth
      - api
      - worker

services:

  auth:
    command:
      - npm
      - run
      - dev

    working_dir: services/auth

    ports:
      http: 8001

    health:
      type: http
      url: http://127.0.0.1:8001/health

    identity:
      type: user

  api:
    command:
      - python
      - main.py

    working_dir: services/api

    dependencies:
      - auth

    ports:
      http: 8000

    environment:
      AUTH_URL: http://127.0.0.1:${services.auth.ports.http}

    health:
      type: http
      url: http://127.0.0.1:8000/health

    identity:
      type: user

  worker:
    command:
      - python
      - worker.py

    working_dir: services/worker

    dependencies:
      - api

    identity:
      type: service_account

      service_account:
        worker-dev@company-dev.iam.gserviceaccount.com

proxy:

  enabled: true

  listen:
    host: 127.0.0.1
    port: 8080

  routes:

    - name: billing

      match:
        host: billing.local

      upstream:
        url: https://billing.example.com

      auth:
        type: iap
        identity:
          type: user

    - name: worker-api

      match:
        host: worker-api.local

      upstream:
        url: https://worker-api.example.com

      auth:
        type: iap
        identity:
          type: service_account

          service_account:
            worker-dev@company-dev.iam.gserviceaccount.com

logs:

  max_memory_events: 50000

  persistence:
    enabled: true

    directory: ~/.devctl/logs

auth:

  refresh_threshold_seconds: 300
```

---

# 129. Required CLI Commands

At minimum:

```text
devctl
devctl start
devctl stop
devctl restart
devctl status
devctl logs
devctl doctor
devctl setup
devctl auth
devctl proxy
devctl config
```

Subcommands:

```text
devctl start <service>
devctl stop <service>
devctl restart <service>

devctl logs [service]
devctl logs export

devctl auth status
devctl auth login
devctl auth logout
devctl auth refresh

devctl proxy status
devctl proxy start
devctl proxy stop

devctl config validate
devctl config show

devctl doctor
devctl setup
```

---

# 130. Status Command

Example:

```text
$ devctl status

PROFILE: backend

SERVICE     STATUS      HEALTH      PID
auth        RUNNING     HEALTHY     10231
api         RUNNING     HEALTHY     10242
worker      RUNNING     HEALTHY     10251

PROXY       RUNNING     127.0.0.1:8080

IDENTITY    developer@company.com

CLOUD       company-dev
```

---

# 131. Exit Codes

CLI must use meaningful exit codes.

Example:

```text
0 = success
1 = general error
2 = configuration error
3 = authentication error
4 = authorization error
5 = service startup failure
6 = health check failure
7 = proxy failure
```

---

# 132. Logging the devctl Application

`devctl` itself must have structured internal logs.

Levels:

```text
DEBUG
INFO
WARN
ERROR
```

Internal logs must be available in the Logs UI but should be distinguishable from service logs.

---

# 133. Observability

The architecture should make it possible to debug `devctl` itself.

Include:

```text
debug logging
request IDs
service IDs
session IDs
token refresh events
proxy events
startup timing
```

---

# 134. Performance Requirements

The TUI must remain responsive with:

```text
20+ services
50,000+ in-memory log events
high-frequency logs
multiple concurrent health checks
multiple concurrent service processes
```

The log system must avoid rendering every event unnecessarily.

---

# 135. Log Backpressure

If a service produces extreme log volume, the system must protect itself.

Possible strategies:

```text
bounded channels
ring buffers
batch UI updates
drop policies
```

The TUI should remain responsive.

---

# 136. UI Update Batching

Do not redraw the entire TUI for every log line.

Batch high-frequency events.

Example:

```text
collect events for 20–50 ms
        ↓
single UI update
```

The exact implementation can vary.

---

# 137. Graceful TUI Exit

When the user exits:

```text
q
 ↓
ask/handle configured shutdown behavior
 ↓
detach or stop services according to policy
```

The behavior must be configurable.

For example:

```yaml
shutdown:
  stop_services_on_exit: false
```

---

# 138. Detach Mode

Support:

```bash
devctl start --detach
```

The services continue running after `devctl` exits.

Then:

```bash
devctl status
devctl logs
```

can reconnect to the existing session.

---

# 139. Attach Mode

Support:

```bash
devctl attach
```

to attach to an existing running session.

The TUI should automatically attach when appropriate.

---

# 140. Service Restart Policies

Support:

```text
never
on_failure
always
```

with:

```text
max_retries
backoff
```

---

# 141. Environment Validation

Allow required environment variables:

```yaml
environment:
  required:
    - PROJECT_ID
    - API_URL
```

Missing variables should be detected before starting the service.

---

# 142. Environment Defaults

Allow:

```yaml
environment:
  defaults:
    LOG_LEVEL: INFO
```

---

# 143. Environment Secret Sources

Future-compatible abstraction:

```text
EnvironmentSource
```

Possible sources:

```text
dotenv
process
Google Secret Manager
local keychain
generated
```

The initial implementation can focus on local `.env` plus secure credentials, but the abstraction should allow future sources.

---

# 144. Google Cloud Environment

Configuration should support:

```yaml
google:
  project_id: company-dev
  region: europe-west1
```

The project must be explicit when required.

---

# 145. Project Detection

If project is not configured, `devctl` may attempt:

```text
gcloud config
ADC project
environment variable
```

but must show the source used.

Example:

```text
Project: company-dev
Source: gcloud configuration
```

---

# 146. Configuration Precedence

Recommended:

```text
CLI flags
    ↓
environment variables
    ↓
local configuration
    ↓
repository configuration
    ↓
defaults
```

The exact precedence must be documented.

---

# 147. TUI Theme

The TUI should support:

```text
dark
light
system/default
```

where the selected terminal framework supports it.

Colors should communicate:

```text
success
warning
error
inactive
running
```

but the application must remain usable without color.

---

# 148. Accessibility

Do not rely solely on color.

Example:

```text
✓ HEALTHY
! WARNING
✗ FAILED
○ STOPPED
● RUNNING
```

---

# 149. Documentation

The repository must include documentation covering:

```text
Installation
Quick Start
Configuration
Services
Profiles
Environment
Authentication
Service Account Impersonation
IAP
Proxy
Logs
TUI
CLI
Doctor
Troubleshooting
Google Cloud Administrator Setup
Developer Setup
Security
Architecture
```

---

# 150. Administrator Documentation

Include a dedicated section for cloud administrators explaining:

1. Create development service accounts.
2. Enable required APIs.
3. Configure IAP.
4. Grant developer group permissions.
5. Grant service-account impersonation permissions.
6. Configure any organization policies.
7. Validate developer access.

The documentation must distinguish administrator actions from developer actions.

---

# 151. Developer Documentation

Developer instructions should ideally reduce setup to:

```bash
gcloud auth application-default login
devctl setup
devctl
```

where appropriate.

The actual required commands must be determined by the implemented authentication flow.

---

# 152. Troubleshooting

Include common failures:

```text
gcloud not installed
ADC unavailable
wrong project
permission denied
service account cannot be impersonated
IAP authentication failure
port already in use
service crashes
health check failure
proxy unavailable
token expired
token audience incorrect
configuration invalid
```

Each must include actionable diagnostics.

---

# 153. Implementation Order

The implementation should be developed in phases, but all required features must ultimately be implemented.

Recommended order:

## Phase 1 — Foundation

```text
CLI
Configuration
Service model
Process manager
Basic TUI
```

## Phase 2 — Service Orchestration

```text
Dependencies
Profiles
Health checks
Restart
Session state
```

## Phase 3 — Logging

```text
Log manager
Event bus
Persistent logs
TUI log viewer
Search/filter
```

## Phase 4 — Identity

```text
Google authentication
Credential manager
User identity
Service account impersonation
```

## Phase 5 — IAP

```text
IAP token manager
Audience handling
Token refresh
```

## Phase 6 — Proxy

```text
Proxy
Routes
Identity selection
Authentication injection
Proxy logging
```

## Phase 7 — Developer Experience

```text
setup
doctor
configuration validation
onboarding
documentation
```

## Phase 8 — Hardening

```text
Security
Performance
Cross-platform
Crash recovery
Testing
```

---

# 154. Definition of Done

The project is not complete until a developer can perform the following workflow.

```text
1. Clone repository
2. Install devctl
3. Run devctl setup
4. Authenticate with Google
5. Select development project
6. Validate permissions
7. Select profile
8. Start multiple services
9. Services start in dependency order
10. Independent services start in parallel
11. Shared environment is injected
12. Service-specific environment is injected
13. Health checks run
14. All logs appear in one TUI
15. Logs can be searched and filtered
16. Developer can inspect service status
17. Developer can inspect identity status
18. Service requiring user identity can authenticate
19. Service requiring service identity can impersonate service account
20. IAP-protected requests work
21. Tokens refresh automatically
22. Proxy routes requests correctly
23. Proxy uses configured identity
24. Service failures are displayed
25. Services can be restarted
26. Services can be stopped
27. devctl can exit and detach
28. devctl can reattach
29. doctor diagnoses problems
30. configuration validation catches invalid configuration
```

---

# 155. Final Architectural Rules

The implementation agent must follow these rules.

## Rule 1

Do not hard-code services.

## Rule 2

Do not hard-code service accounts.

## Rule 3

Do not hard-code ports.

## Rule 4

Do not hard-code profiles.

## Rule 5

Do not hard-code environment variables.

## Rule 6

Do not store long-lived service-account private keys by default.

## Rule 7

Prefer Google-supported service-account impersonation.

## Rule 8

Keep user identity and service identity separate.

## Rule 9

Identity must be configuration-driven.

## Rule 10

IAP authentication must support automatic token refresh.

## Rule 11

The proxy must default to localhost-only binding.

## Rule 12

The token manager must prevent concurrent refresh storms.

## Rule 13

Logs must be centralized.

## Rule 14

The TUI must remain responsive under high log volume.

## Rule 15

The TUI must communicate with domain/application services rather than directly managing processes.

## Rule 16

All cloud dependencies must have actionable diagnostics.

## Rule 17

The system must work for purely local services without Google Cloud.

## Rule 18

Google Cloud must be required only for services/features that actually need it.

## Rule 19

Configuration must be version-controlled and human-readable.

## Rule 20

Adding or removing services must not require changing application source code.

## Rule 21

Secrets must never appear in logs.

## Rule 22

Tokens must never appear in normal TUI output.

## Rule 23

The system must support both CLI automation and interactive TUI usage.

## Rule 24

The implementation must include automated tests for the major subsystems.

## Rule 25

The architecture must remain extensible for additional authentication providers, service types, log parsers, proxy middleware, and cloud providers.

---

# 156. Target User Experience

The final developer experience should feel like a unified local development control center.

Instead of:

```text
Terminal 1 → auth service
Terminal 2 → API
Terminal 3 → worker
Terminal 4 → frontend
Terminal 5 → logs
Terminal 6 → proxy
Terminal 7 → gcloud commands
```

the developer should have:

```bash
devctl
```

and one TUI:

```text
┌─────────────────────────────────────────────────────────────┐
│ DEVCTL                                                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Services                                                    │
│                                                             │
│ ✓ auth       healthy                                       │
│ ✓ api        healthy                                       │
│ ✓ worker     healthy                                       │
│ ✓ frontend   healthy                                       │
│                                                             │
│ Identity                                                    │
│ developer@company.com                                       │
│                                                             │
│ Service identities                                          │
│ ✓ worker-dev                                                │
│ ✓ billing-dev                                               │
│                                                             │
│ Proxy                                                       │
│ ✓ 127.0.0.1:8080                                           │
│                                                             │
│ Logs                                                        │
│ 12,482 events                                               │
│ 3 errors                                                    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ [s] Services [l] Logs [a] Auth [p] Proxy [d] Doctor [q]    │
└─────────────────────────────────────────────────────────────┘
```

The developer should be able to:

```text
start
stop
restart
inspect
debug
authenticate
proxy
search logs
switch identities
switch profiles
diagnose problems
```

without leaving the TUI.

---

# 157. Final Goal

`devctl` should become the standard local-development control plane for the company's services.

It should provide a single abstraction over:

```text
Local Processes
       +
Environment
       +
Service Dependencies
       +
Google Identity
       +
Service Identity
       +
IAP
       +
Authentication
       +
Local Proxy
       +
Health Checks
       +
Logs
       +
TUI
       +
Developer Diagnostics
```

while remaining:

```text
configuration-driven
secure
extensible
cross-platform
testable
maintainable
developer-friendly
```

The implementation agent must implement the architecture as a coherent system rather than a collection of independent commands.
