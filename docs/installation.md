# Installation

`devctl` is TypeScript. You run it with [Bun](https://bun.sh).

## Bun

```bash
# https://bun.sh — then make sure the binary is on PATH
export PATH="$HOME/.bun/bin:$PATH"
```

## From this repository

```bash
git clone https://github.com/amrmohamed/devctl
cd devctl/app
bun install
```

Run without installing a global command:

```bash
bun run src/bin.ts --help
# from the repo root:
bun run app/src/bin.ts --help
```

Link the `devctl` command onto your PATH:

```bash
cd app && bun link
devctl version
```

`bun link` registers the `bin` entry in `app/package.json` (`devctl` → `./src/bin.ts`).

## Google Cloud CLI (optional)

Install `gcloud` only if you use user identity, impersonation, or IAP. Local-only services do not need it. See [Authentication](authentication.md).

## Cross-platform

macOS, Linux, and Windows. Process-group handling is OS-specific (`app/src/processes/`); the rest of the application is shared.

## Related

- [Quick start](quickstart.md)
- [Building from source](typescript.md)
- [How it fits together](overview.md)
