import { join, relative, sep } from "node:path";
import type { FileSystem } from "../../ports/filesystem.ts";
import {
  VIRTUAL_COLLECTION_ID,
  type HttpClientCollection,
  type HttpClientEnvironment,
  type CollectionItem,
} from "../../domain/httpclient/request.ts";
import { emptyHttpClientAuth } from "../../domain/httpclient/request.ts";
import { folderItem, parseBruEnvironment, parseBruRequest, parseCollectionBru, requestItem } from "./bru.ts";

const BRUNO_MARKER = "bruno.json";
const COLLECTION_BRU = "collection.bru";
const FOLDER_BRU = "folder.bru";
const ENV_DIR = "environments";
const MAX_DEPTH = 10;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "vendor",
  ".next",
  "target",
  ".turbo",
  ".cache",
  ".devctl",
]);

export function discoverCollections(
  fs: FileSystem,
  repoRoot: string,
  searchPaths: readonly string[],
): HttpClientCollection[] {
  const roots = searchPaths.length > 0 ? searchPaths.map((path) => resolveRepoPath(repoRoot, path)) : [repoRoot];
  const seen = new Set<string>();
  const out: HttpClientCollection[] = [];
  for (const root of roots) {
    walkForMarkers(fs, repoRoot, root, 0, seen, out);
  }
  return out;
}

function walkForMarkers(
  fs: FileSystem,
  repoRoot: string,
  dir: string,
  depth: number,
  seen: Set<string>,
  out: HttpClientCollection[],
): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  const marker = join(dir, BRUNO_MARKER);
  if (fs.exists(marker)) {
    const id = collectionIdFor(repoRoot, dir);
    if (id === VIRTUAL_COLLECTION_ID || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push(loadCollection(fs, repoRoot, dir, id));
    return;
  }
  for (const entry of fs.listDir(dir)) {
    if (entry.kind !== "dir" || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }
    walkForMarkers(fs, repoRoot, join(dir, entry.name), depth + 1, seen, out);
  }
}

function loadCollection(fs: FileSystem, repoRoot: string, dir: string, id: string): HttpClientCollection {
  const name = collectionName(fs, dir, id);
  const meta = readCollectionMeta(fs, join(dir, COLLECTION_BRU));
  const environments = readEnvironments(fs, join(dir, ENV_DIR));
  const items = readDirItems(fs, dir, "");
  return {
    id,
    name,
    source: "bruno",
    path: posixRel(repoRoot, dir),
    readonly: true,
    vars: meta.vars,
    headers: meta.headers,
    auth: meta.auth,
    items,
    environments,
  };
}

function readDirItems(fs: FileSystem, dir: string, prefix: string): CollectionItem[] {
  const items: CollectionItem[] = [];
  const entries = [...fs.listDir(dir)].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.kind === "dir") {
      if (entry.name === ENV_DIR || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const child = join(dir, entry.name);
      const folderId = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const folderMeta = readCollectionMeta(fs, join(child, FOLDER_BRU));
      items.push(folderItem(folderId, entry.name, readDirItems(fs, child, folderId), folderMeta.vars, folderMeta.auth, folderMeta.headers));
      continue;
    }
    if (!entry.name.endsWith(".bru") || entry.name === COLLECTION_BRU || entry.name === FOLDER_BRU) {
      continue;
    }
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const id = rel.replace(/\.bru$/i, "");
    try {
      const contents = fs.readText(join(dir, entry.name));
      items.push(requestItem(parseBruRequest(contents, id, id.split("/").pop() ?? id)));
    } catch {
      // skip unreadable or invalid .bru files
    }
  }
  return items;
}

function readEnvironments(fs: FileSystem, dir: string): HttpClientEnvironment[] {
  if (!fs.exists(dir)) {
    return [];
  }
  const out: HttpClientEnvironment[] = [];
  for (const entry of fs.listDir(dir)) {
    if (entry.kind !== "file" || !entry.name.endsWith(".bru")) {
      continue;
    }
    const id = entry.name.replace(/\.bru$/i, "");
    out.push({
      id,
      name: id,
      vars: parseBruEnvironment(fs.readText(join(dir, entry.name))),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readCollectionMeta(fs: FileSystem, path: string): ReturnType<typeof parseCollectionBru> {
  if (!fs.exists(path)) {
    return { vars: [], auth: emptyHttpClientAuth(), headers: [] };
  }
  try {
    return parseCollectionBru(fs.readText(path));
  } catch {
    return { vars: [], auth: emptyHttpClientAuth(), headers: [] };
  }
}

function collectionName(fs: FileSystem, dir: string, fallback: string): string {
  try {
    const raw = JSON.parse(fs.readText(join(dir, BRUNO_MARKER))) as { name?: unknown };
    if (typeof raw.name === "string" && raw.name !== "") {
      return raw.name;
    }
  } catch {
    // fall through to folder name
  }
  const parts = fallback.split("/");
  return parts[parts.length - 1] || fallback;
}

function collectionIdFor(repoRoot: string, dir: string): string {
  const rel = posixRel(repoRoot, dir);
  return rel === "" || rel === "." ? "collection" : rel;
}

function posixRel(repoRoot: string, dir: string): string {
  const rel = relative(repoRoot, dir);
  if (rel === "") {
    return "";
  }
  return rel.split(sep).join("/");
}

function resolveRepoPath(repoRoot: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return path;
  }
  return join(repoRoot, path);
}
