import { prettyHttpBody, type HttpClientHeader, type HttpClientRequest, type HttpClientTreeRow } from "../../../domain/httpclient/request.ts";
import type { HttpClientSendResult } from "../../../ports/http-client.ts";
import { EmptyState } from "../chrome.tsx";
import { clipText, padClip } from "../helpers/format.ts";
import { formatByteSize, HTTP_REQUEST_TABS, HTTP_RESPONSE_TABS, methodTone, type HttpRequestTab, type HttpResponseTab } from "../helpers/httpclient.ts";
import { Chip, MetaBar, ScreenFrame, scrollboxStyle, useScrollSelectedIntoView } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import type { HttpClientView } from "../hooks/use-http-client.ts";

function TreeRow(props: {
  palette: Palette;
  row: HttpClientTreeRow;
  selected: boolean;
  index: number;
  width: number;
  onPick: () => void;
}) {
  const { palette, row, selected, width } = props;
  const indent = "  ".repeat(row.depth);
  const method = row.method ? padClip(row.method, 7) : "       ";
  const label = `${indent}${row.kind === "request" ? method : ""}${row.name}`;
  return (
    <box
      id={`http-tree-${props.index}`}
      height={1}
      overflow="hidden"
      backgroundColor={selected ? palette.highlight : undefined}
      onMouseDown={props.onPick}
    >
      <text fg={row.kind === "request" ? palette.text : palette.muted}>{clipText(label, Math.max(8, width - 2))}</text>
    </box>
  );
}

function HeaderList(props: { palette: Palette; headers: readonly HttpClientHeader[]; width: number }) {
  if (props.headers.length === 0) {
    return <text fg={props.palette.muted}>none</text>;
  }
  return (
    <box flexDirection="column" overflow="hidden">
      {props.headers.map((header) => (
        <text key={`${header.name}:${header.value}`} fg={props.palette.text} wrapMode="none">
          {clipText(`${header.name}: ${header.value}`, Math.max(8, props.width - 2))}
        </text>
      ))}
    </box>
  );
}

function RequestTabBody(props: { palette: Palette; draft: HttpClientRequest; tab: HttpRequestTab; width: number; editingBody: boolean; onBody: (value: string) => void }) {
  const { palette, draft, tab, width, editingBody, onBody } = props;
  if (tab === "params") {
    if (draft.params.length === 0) {
      return <text fg={palette.muted}>no params</text>;
    }
    return (
      <box flexDirection="column">
        {draft.params.map((param) => (
          <text key={`${param.kind}:${param.name}`} fg={palette.text}>
            {clipText(`${param.kind} ${param.name}=${param.value}`, Math.max(8, width - 2))}
          </text>
        ))}
      </box>
    );
  }
  if (tab === "headers") {
    return <HeaderList palette={palette} headers={draft.headers} width={width} />;
  }
  if (tab === "auth") {
    return <text fg={palette.text}>{`${draft.auth.mode}${draft.auth.token !== "" ? " · token set" : ""}`}</text>;
  }
  if (tab === "vars") {
    if (draft.vars.length === 0) {
      return <text fg={palette.muted}>no request vars</text>;
    }
    return (
      <box flexDirection="column">
        {draft.vars.map((item) => (
          <text key={item.name} fg={palette.text}>{clipText(`${item.name}=${item.value}`, Math.max(8, width - 2))}</text>
        ))}
      </box>
    );
  }
  const text = draft.body.mode === "graphql" ? draft.body.graphqlQuery : draft.body.text;
  if (editingBody) {
    return (
      <input
        focused
        value={text}
        onInput={onBody}
        backgroundColor={palette.highlight}
        focusedBackgroundColor={palette.highlight}
        textColor={palette.text}
        cursorColor={palette.primary}
      />
    );
  }
  if (text === "") {
    return <text fg={palette.muted}>{`body ${draft.body.mode} · press b to edit`}</text>;
  }
  return (
    <text fg={palette.text} wrapMode="word">
      {prettyHttpBody(text)}
    </text>
  );
}

function ResponsePane(props: { palette: Palette; result?: HttpClientSendResult; tab: HttpResponseTab; width: number; focused: boolean }) {
  const { palette, result, tab, width, focused } = props;
  return (
    <box
      flexGrow={1}
      border
      borderStyle="single"
      borderColor={focused ? palette.borderActive : palette.border}
      title="response"
      titleColor={focused ? palette.primary : palette.muted}
      flexDirection="column"
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexDirection="row" overflow="hidden">
        {HTTP_RESPONSE_TABS.map((item) => (
          <Chip key={item} palette={palette} label={item} tone={item === tab ? "primary" : "ghost"} />
        ))}
      </box>
      {!result ? (
        <text fg={palette.muted}>press s to send</text>
      ) : tab === "headers" ? (
        <HeaderList palette={palette} headers={result.response.headers} width={width} />
      ) : (
        <scrollbox focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
          <text fg={palette.text} wrapMode="word">
            {prettyHttpBody(result.response.body)}
          </text>
        </scrollbox>
      )}
    </box>
  );
}

export function HttpClientScreen(props: {
  palette: Palette;
  view: HttpClientView;
  selected: number;
  width: number;
  onPick: (index: number) => void;
}) {
  const { palette, view, selected, width, onPick } = props;
  const treeWidth = Math.min(42, Math.max(24, Math.floor(width * 0.28)));
  const requestWidth = Math.max(20, Math.floor((width - treeWidth) / 2));
  const treeScroll = useScrollSelectedIntoView(selected, "http-tree");
  const editingUrl = view.inputField === "url";
  const editingFilter = view.inputField === "filter";
  const editingBody = view.inputField === "body";
  const statusTone = !view.result ? "idle" : view.result.response.status >= 400 ? "error" : "success";

  return (
    <ScreenFrame palette={palette} title="http">
      <MetaBar
        palette={palette}
        items={[
          { text: view.pane, tone: "info" },
          { text: view.env || "no env", tone: view.env ? "success" : "idle" },
          { text: view.sending ? "sending" : view.result ? `${view.result.response.status}` : "idle", tone: view.sending ? "warning" : statusTone },
          ...(view.result ? [{ text: `${view.result.response.durationMs}ms ${formatByteSize(view.result.response.size)}`, tone: "muted" as const }] : []),
          ...(view.result?.authAttached ? [{ text: "token", tone: "success" as const }] : []),
        ]}
        hints={[{ key: "s", label: "send" }, { key: "tab", label: "pane" }, { key: "e", label: "url" }]}
      />
      {view.error ? (
        <text fg={palette.error} wrapMode="word">
          {view.error}
        </text>
      ) : null}
      {editingFilter ? (
        <box height={1} paddingLeft={1} backgroundColor={palette.highlight} overflow="hidden">
          <input
            focused
            value={view.filter}
            placeholder="filter collections"
            onInput={view.setFilter}
            backgroundColor={palette.highlight}
            focusedBackgroundColor={palette.highlight}
            textColor={palette.text}
            cursorColor={palette.primary}
          />
        </box>
      ) : null}
      <box flexGrow={1} flexDirection="row" overflow="hidden">
        <box
          width={treeWidth}
          border
          borderStyle="single"
          borderColor={view.pane === "tree" ? palette.borderActive : palette.border}
          title="collections"
          titleColor={view.pane === "tree" ? palette.primary : palette.muted}
          flexDirection="column"
          overflow="hidden"
        >
          {view.tree.length === 0 ? (
            <EmptyState palette={palette} title="No collections" body="Add a bruno.json collection or configure services to populate the virtual devctl collection." />
          ) : (
            <scrollbox ref={treeScroll} focused={false} stickyScroll={false} scrollX={false} style={scrollboxStyle(palette)}>
              <box flexDirection="column" overflow="hidden">
                {view.tree.map((row, index) => (
                  <TreeRow
                    key={row.id}
                    palette={palette}
                    row={row}
                    index={index}
                    selected={index === selected}
                    width={treeWidth}
                    onPick={() => onPick(index)}
                  />
                ))}
              </box>
            </scrollbox>
          )}
        </box>
        <box
          flexGrow={1}
          border
          borderStyle="single"
          borderColor={view.pane === "request" ? palette.borderActive : palette.border}
          title="request"
          titleColor={view.pane === "request" ? palette.primary : palette.muted}
          flexDirection="column"
          overflow="hidden"
          paddingLeft={1}
          paddingRight={1}
        >
          <box height={1} flexDirection="row" overflow="hidden">
            <Chip palette={palette} label={view.draft.method || "GET"} tone={methodTone(view.draft.method)} />
            {editingUrl ? (
              <input
                focused
                value={view.draft.url}
                onInput={(value) => view.setDraft({ ...view.draft, url: value })}
                backgroundColor={palette.highlight}
                focusedBackgroundColor={palette.highlight}
                textColor={palette.text}
                cursorColor={palette.primary}
              />
            ) : (
              <text fg={palette.text}>{clipText(view.draft.url || "(no url)", Math.max(8, requestWidth - 10))}</text>
            )}
          </box>
          <box height={1} flexDirection="row" overflow="hidden">
            {HTTP_REQUEST_TABS.map((item) => (
              <Chip key={item} palette={palette} label={item} tone={item === view.requestTab ? "primary" : "ghost"} />
            ))}
          </box>
          <RequestTabBody
            palette={palette}
            draft={view.draft}
            tab={view.requestTab}
            width={requestWidth}
            editingBody={editingBody}
            onBody={(value) => view.setDraft({ ...view.draft, body: { ...view.draft.body, text: value } })}
          />
        </box>
        <ResponsePane palette={palette} result={view.result} tab={view.responseTab} width={requestWidth} focused={view.pane === "response"} />
      </box>
    </ScreenFrame>
  );
}
