import { LoadingState } from "../chrome.tsx";
import { Banner, FieldRow, ScreenFrame } from "../layout.tsx";
import { type Palette } from "../themes.ts";
import { type CredentialsSnapshot } from "../../types.ts";

export function CredentialsScreen(props: { palette: Palette; credentials?: CredentialsSnapshot }) {
  const { palette, credentials } = props;
  if (!credentials) {
    return <LoadingState palette={palette} label="Reading credential store…" />;
  }
  return (
    <ScreenFrame palette={palette} title="credentials" scroll>
      <FieldRow palette={palette} label="backend" value={credentials.backend} />
      <text fg={palette.muted} wrapMode="word">
        Tokens stay in the OS keychain or ~/.devctl/credentials (0600). They are never shown here.
      </text>
      {credentials.entries.length === 0 ? (
        <text fg={palette.muted}>no cached credentials</text>
      ) : (
        credentials.entries.map((entry) => (
          <FieldRow
            key={`${entry.identity}|${entry.audience}`}
            palette={palette}
            label={entry.identity}
            value={`${entry.valid ? "valid" : "expired"}  ${entry.expires_at}  ${entry.audience || "(no audience)"}`}
            tone={entry.valid ? "success" : "warning"}
          />
        ))
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
