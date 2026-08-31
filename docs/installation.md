# Installation

`devctl` is TypeScript. You run it with [Bun](https://bun.sh) **1.4.0** or later, or you install a tagged binary from GitHub Releases.

`devctl version` prints `devctl <semver>`. Tagged binaries bake that version in at compile time.

## From a GitHub Release

After a `v*` tag, the [Release](https://github.com/amr-m-abdelgawad/devctl/actions/workflows/release.yml) workflow installs OpenTUI native packages for every OS/CPU (`bun install --os="*" --cpu="*"`), then publishes compile artifacts:

| Asset | Platform |
|-------|----------|
| `devctl-darwin-arm64` | macOS Apple silicon |
| `devctl-darwin-x64` | macOS Intel |
| `devctl-linux-x64` | Linux x64 |
| `devctl-linux-arm64` | Linux arm64 |
| `devctl-windows-x64.exe` | Windows x64 |

```bash
# example — pick the asset for your OS
chmod +x devctl-darwin-arm64
sudo mv devctl-darwin-arm64 /usr/local/bin/devctl
devctl version
```

There is no npm package. A Homebrew formula lives in this repo (not Homebrew-core):

```bash
brew install --formula https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/homebrew/devctl.rb
```

`devctl update` reports whether a newer GitHub Release exists and prints that install hint. It does not overwrite the running binary.

The published artifact is the GitHub Release binary.

## From this repository

```bash
# https://bun.sh — then make sure the binary is on PATH
export PATH="$HOME/.bun/bin:$PATH"

git clone https://github.com/amr-m-abdelgawad/devctl.git
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

## Shell completions

```bash
source <(devctl completion zsh)    # or bash
devctl completion fish > ~/.config/fish/completions/devctl.fish
```

See [CLI](cli.md).

## Google Cloud CLI (optional)

Install `gcloud` only if you use user identity, impersonation, or IAP. Local-only services do not need it. See [Authentication](authentication.md).

## Cross-platform

macOS, Linux, and Windows. Process-group handling is OS-specific (`app/src/processes/`). Attach and CLI-over-session use `devctl.sock` on Unix and a named pipe (`\\.\pipe\devctl-<repoID>`) on Windows.

## Related

- [Quick start](quickstart.md)
- [Building from source](typescript.md)
- [How it fits together](overview.md)
- [Changelog](../CHANGELOG.md)
