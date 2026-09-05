# Installation

The recommended installation is the public npm package. It includes an official Bun runtime, so Node.js 18 or later is the only prerequisite.

## From npm (recommended)

Install the command for regular use:

```bash
npm install --global @amr-m-abdelgawad/devctl
devctl version
```

Or try the latest version without a global installation:

```bash
npx @amr-m-abdelgawad/devctl@latest
```

The npm package contains bundled JavaScript, not a compiled devctl executable. Its small Node launcher invokes the package-local official Bun runtime and forwards the terminal, arguments, current directory, environment, signals, and exit status. npm provenance links public releases to this repository's release workflow.

Do not install with `--ignore-scripts`: Bun's npm package uses its installation script to select the runtime for the current operating system and CPU.

## From a GitHub Release (unsigned alternative)

After a `v*` tag, the [Release](https://github.com/amr-m-abdelgawad/devctl/actions/workflows/release.yml) workflow publishes these standalone artifacts:

| Asset | Platform |
|-------|----------|
| `devctl-darwin-arm64` | macOS Apple silicon |
| `devctl-darwin-x64` | macOS Intel |
| `devctl-linux-x64` | Linux x64 |
| `devctl-linux-arm64` | Linux arm64 |
| `devctl-windows-x64.exe` | Windows x64 |

```bash
# Example only: download the asset and SHA256SUMS from the same release,
# verify its hash, then install it.
grep ' devctl-darwin-arm64$' SHA256SUMS | shasum -a 256 -c -
chmod +x devctl-darwin-arm64
sudo mv devctl-darwin-arm64 /usr/local/bin/devctl
devctl version
```

These binaries are not signed with Apple Developer ID or Windows Authenticode. Checksums and GitHub build attestations prove integrity and build origin, but they do not make the operating system display devctl as a verified publisher.

A Homebrew formula lives in this repository rather than Homebrew-core:

```bash
brew install --formula https://raw.githubusercontent.com/amr-m-abdelgawad/devctl/main/homebrew/devctl.rb
```

`devctl update` reports whether a newer GitHub Release exists and recommends the npm update command first. It never overwrites the running installation.

## From source

```bash
# Source development requires Bun 1.4.0 or later.
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

The npm package supports macOS arm64/x64, Linux arm64/x64 (glibc or musl), and Windows x64. Process-group handling is OS-specific (`app/src/adapters/process/`). Attach and CLI-over-session use `devctl.sock` on Unix and a named pipe (`\\.\pipe\devctl-<repoID>`) on Windows.

## Related

- [Quick start](quickstart.md)
- [Building from source](typescript.md)
- [Contributing](../CONTRIBUTING.md)
- [npm publishing (maintainers)](npm-publishing.md)
- [How it fits together](overview.md)
- [Changelog](../CHANGELOG.md)
