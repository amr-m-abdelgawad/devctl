import { Command } from "commander";
import type { ClientRuntime, Controller } from "../../application/client-runtime.ts";
import {
  cloneHttpClientRequest,
  emptyHttpClientRequest,
  flattenTree,
  parseRequestRef,
  prettyHttpBody,
  type HttpClientCollection,
  type HttpClientSendInput,
} from "../../domain/httpclient/request.ts";
import type { HttpClientSendResult } from "../../ports/http-client.ts";
import { KindGeneral, newError } from "../../shared/errors.ts";
import { configFlag, writeOut } from "./shared.ts";

type HttpCommonOpts = {
  env?: string;
  profile?: string;
  var?: string[];
  insecureAttachToken?: boolean;
  json?: boolean;
  header?: string[];
  body?: string;
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePairs(values: readonly string[] | undefined, separator: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of values ?? []) {
    const index = item.indexOf(separator);
    if (index <= 0) {
      throw newError(KindGeneral, `expected name${separator}value, got "${item}"`);
    }
    out[item.slice(0, index).trim()] = item.slice(index + separator.length).trim();
  }
  return out;
}

export function formatHttpSendResult(result: HttpClientSendResult): string {
  const auth = result.authAttached ? "attached" : result.tokenDecision;
  const truncated = result.response.truncated ? " truncated" : "";
  const lines = [
    `${result.response.status} ${result.response.statusText}  ${result.response.durationMs}ms  ${result.response.size}b  token:${auth}${truncated}`,
    result.url,
  ];
  for (const header of result.response.headers) {
    lines.push(`${header.name}: ${header.value}`);
  }
  lines.push("");
  lines.push(prettyHttpBody(result.response.body));
  return `${lines.join("\n")}\n`;
}

export function formatHttpList(collections: readonly HttpClientCollection[]): string {
  const lines: string[] = [];
  for (const collection of collections) {
    const rows = flattenTree(collection);
    const requests = rows.filter((row) => row.kind === "request");
    const mark = collection.source === "devctl" ? "virtual" : collection.source;
    lines.push(`${collection.id}  ${collection.name}  (${mark}, ${requests.length} requests)`);
    for (const row of requests) {
      const method = (row.method ?? "GET").padEnd(6);
      lines.push(`  ${method} ${collection.id}/${row.requestId}`);
    }
  }
  return lines.length === 0 ? "no collections\n" : `${lines.join("\n")}\n`;
}

async function withController<T>(runtime: ClientRuntime, root: Command, fn: (ctrl: Controller) => Promise<T>): Promise<T> {
  const ctrl = await runtime.openController("", configFlag(root), true);
  try {
    return await fn(ctrl);
  } finally {
    await ctrl.close();
  }
}

function sendOpts(opts: HttpCommonOpts): Pick<HttpClientSendInput, "env" | "profile" | "vars" | "insecureAttachToken"> {
  return {
    env: opts.env,
    profile: opts.profile,
    vars: parsePairs(opts.var, "="),
    insecureAttachToken: opts.insecureAttachToken === true,
  };
}

async function sendAndPrint(ctrl: Controller, input: HttpClientSendInput, json: boolean): Promise<void> {
  const raw = await ctrl.httpSend(input, true);
  if (!("response" in raw)) {
    throw newError(KindGeneral, "daemon returned a pending id instead of a response");
  }
  if (json) {
    writeOut(`${JSON.stringify(raw, null, 2)}\n`);
    return;
  }
  writeOut(formatHttpSendResult(raw));
}

function inlineFromFlags(method: string, url: string, opts: HttpCommonOpts) {
  const request = cloneHttpClientRequest(emptyHttpClientRequest());
  request.id = "inline";
  request.name = "inline";
  request.method = method.toUpperCase();
  request.url = url;
  request.headers = Object.entries(parsePairs(opts.header, ":")).map(([name, value]) => ({ name, value, enabled: true }));
  if (opts.body !== undefined && opts.body !== "") {
    const json = opts.body.trim().startsWith("{") || opts.body.trim().startsWith("[");
    request.body.mode = json ? "json" : "text";
    request.body.text = opts.body;
  }
  return request;
}

function addCommonSendOptions(cmd: Command): Command {
  return cmd
    .option("--env <name>", "Bruno environment name")
    .option("--profile <name>", "devctl profile whose env is the var source")
    .option("--var <name=value>", "runtime variable (repeatable)", collect, [])
    .option("--insecure-attach-token", "attach a devctl token even for unknown hosts")
    .option("--json", "machine-readable output");
}

export function addHttpClient(root: Command, runtime: ClientRuntime): void {
  const http = root.command("http").description("send HTTP requests from Bruno collections and configured services");
  http
    .command("ls")
    .description("list collections and requests")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await withController(runtime, root, async (ctrl) => {
        const listed = await ctrl.httpList();
        const collections: HttpClientCollection[] = [];
        for (const summary of listed.collections) {
          collections.push(await ctrl.httpCollection(summary.id));
        }
        if (opts.json) {
          writeOut(`${JSON.stringify({ collections }, null, 2)}\n`);
          return;
        }
        writeOut(formatHttpList(collections));
      });
    });

  addCommonSendOptions(
    http.command("send")
      .description("run a saved request")
      .argument("<path>", "collection/request, e.g. devctl/service:api"),
  ).action(async (path: string, opts: HttpCommonOpts) => {
    const ref = parseRequestRef(path);
    if (!ref) {
      throw newError(KindGeneral, `request path must be collection/request, got "${path}"`);
    }
    await withController(runtime, root, async (ctrl) => {
      await sendAndPrint(ctrl, { ...ref, ...sendOpts(opts) }, opts.json === true);
    });
  });

  addCommonSendOptions(
    http.command("get")
      .description("send an ad-hoc GET")
      .argument("<url>", "URL, may include ${devctl} and {{bruno}} refs")
      .option("-H, --header <name:value>", "header (repeatable)", collect, [])
      .option("--body <text>", "request body"),
  ).action(async (url: string, opts: HttpCommonOpts) => {
    await withController(runtime, root, async (ctrl) => {
      await sendAndPrint(ctrl, { inline: inlineFromFlags("GET", url, opts), ...sendOpts(opts) }, opts.json === true);
    });
  });

  addCommonSendOptions(
    http.command("post")
      .description("send an ad-hoc POST")
      .argument("<url>", "URL, may include ${devctl} and {{bruno}} refs")
      .option("-H, --header <name:value>", "header (repeatable)", collect, [])
      .option("--body <text>", "request body"),
  ).action(async (url: string, opts: HttpCommonOpts) => {
    await withController(runtime, root, async (ctrl) => {
      await sendAndPrint(ctrl, { inline: inlineFromFlags("POST", url, opts), ...sendOpts(opts) }, opts.json === true);
    });
  });
}
