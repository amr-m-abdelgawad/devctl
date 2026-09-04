#!/usr/bin/env bash
set -euo pipefail

src="${1:-docs}"
dest="${2:-wiki-out}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
blob="https://github.com/${repo}/blob/main"

rm -rf "${dest}"
mkdir -p "${dest}"
cp -R "${src}/." "${dest}/"

if [[ -f "${dest}/README.md" ]]; then
  mv "${dest}/README.md" "${dest}/Home.md"
fi

python3 - "${dest}" "${blob}" <<'PY'
from pathlib import Path
import re
import sys

dest = Path(sys.argv[1])
blob = sys.argv[2]

md_link = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

def rewrite(url: str) -> str:
    if url.startswith(("http://", "https://", "mailto:", "#")):
        return url
    if url.startswith("../"):
        return f"{blob}/{url[3:]}"
    path, frag = (url.split("#", 1) + [""])[:2]
    suffix = f"#{frag}" if frag else ""
    if path.endswith(".md"):
        name = Path(path).name
        page = "Home" if name.lower() == "readme.md" else Path(name).stem
        return f"{page}{suffix}"
    return url

for path in dest.glob("*.md"):
    if path.name.startswith("_"):
        continue
    text = path.read_text()
    path.write_text(md_link.sub(lambda m: f"[{m.group(1)}]({rewrite(m.group(2))})", text))
PY

cat > "${dest}/_Sidebar.md" <<EOF
**[Home](Home)**

**Start**
* [How it fits together](overview)
* [Installation](installation)
* [Quick start](quickstart)
* [Developer setup](developer-setup)
* [Agent skills](${blob}/skills/README.md)

**Use**
* [TUI](tui)
* [CLI](cli)
* [MCP](mcp)
* [Logs](logs)
* [Doctor](doctor)
* [Troubleshooting](troubleshooting)

**Configure**
* [Configuration](configuration)
* [Services](services)
* [Profiles](profiles)
* [Environment](environment)
* [Plugins](plugins)

**Identity**
* [Authentication](authentication)
* [Impersonation](impersonation)
* [IAP](iap)
* [Proxy](proxy)
* [Admin setup](admin-setup)
* [Security](security)

**Reference**
* [Building from source](typescript)
* [npm publishing](npm-publishing)
* [Architecture spec](devctl-architecture)
* [Contributing](${blob}/CONTRIBUTING.md)
* [Security policy](${blob}/SECURITY.md)
EOF

cat > "${dest}/_Footer.md" <<EOF
[Edit in the repo](https://github.com/${repo}/tree/main/docs) · [MIT](${blob}/LICENSE)
EOF
