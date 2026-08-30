import { LoadingState } from "../chrome.tsx";
import { Banner, Chip, ScreenFrame } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type CredentialsSnapshot } from "../../types.ts";

export function CredentialsScreen(props: { palette: Palette; credentials?: CredentialsSnapshot }) {
  const { palette, credentials } = props;
  if (!credentials) {
    return <LoadingState palette={palette} label="Reading credential store…" />;
  }
  const validCount = credentials.entries.filter((e) => e.valid).length;
  const expiredCount = credentials.entries.length - validCount;
  return (
    <ScreenFrame palette={palette} title="credentials" scroll>
      <box height={1} flexDirection="row" overflow="hidden" flexShrink={0}>
        <Chip palette={palette} label={`backend: ${credentials.backend}`} tone="info" />
        {credentials.entries.length > 0 ? <Chip palette={palette} label={`${validCount} valid`} tone="success" /> : null}
        {expiredCount > 0 ? <Chip palette={palette} label={`${expiredCount} expired`} tone="warning" /> : null}
      </box>
      <text fg={palette.muted} wrapMode="word">
        Tokens stay in the OS keychain or ~/.devctl/credentials (0600). They are never shown here.
      </text>
      <box height={1} flexShrink={0} />
      {credentials.entries.length === 0 ? (
        <text fg={palette.muted}>no cached credentials</text>
      ) : (
        <box flexDirection="column" overflow="hidden" gap={1}>
          {credentials.entries.map((entry) => (
            <box
              key={`${entry.identity}|${entry.audience}`}
              border
              borderStyle="rounded"
              borderColor={entry.valid ? palette.success : palette.warning}
              title={entry.identity}
              titleColor={entry.valid ? palette.success : palette.warning}
              flexDirection="column"
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              overflow="hidden"
            >
              <text wrapMode="none">
                <span fg={entry.valid ? palette.success : palette.warning}>{entry.valid ? "✓ valid" : "✗ expired"}</span>
                <span fg={palette.muted}>{`  ·  expires ${entry.expires_at}`}</span>
              </text>
              <text fg={palette.muted} wrapMode="none">
                {`audience: ${entry.audience || "(none)"}`}
              </text>
            </box>
          ))}
        </box>
      )}
      <Banner
        palette={palette}
        title="Actions"
        body="Use /refresh to mint again or auth refresh on the CLI. Invalidate clears the store without printing tokens."
        hint="/refresh   /auth"
      />
    </ScreenFrame>
  );
}
