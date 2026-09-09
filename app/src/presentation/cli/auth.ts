import { Command } from "commander";
import type { ClientRuntime } from "../../application/client-runtime.ts";
import { configFlag, writeOut } from "./shared.ts";

export function addAuth(root: Command, runtime: ClientRuntime): void {
  const auth = root.command("auth").description("Google authentication");
  auth
    .command("status")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      let project = "";
      try {
        project = runtime.load("", configFlag(root)).google.project_id;
      } catch {
        project = "";
      }
      const st = await runtime.detectGoogle(project);
      if (opts.json) {
        writeOut(JSON.stringify(st, null, 2) + "\n");
        return;
      }
      writeOut(`User:      ${st.userEmail || "(unknown)"}\n`);
      writeOut(`Project:   ${st.projectID || "(unset)"}\n`);
      if (st.projectID !== "") {
        writeOut(`Source:    ${st.projectSource}\n`);
      }
      writeOut(`ADC:       ${st.adcAvailable}\n`);
      writeOut(`gcloud:    ${st.gcloudInstalled}\n`);
    });
  auth.command("login").action(async () => {
    await runtime.loginGoogle();
  });
  auth.command("logout").action(async () => {
    await runtime.logoutGoogle();
  });
  auth
    .command("refresh")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      // Keep the standalone user-token refresh working when no daemon is
      // running, but also ask an attached daemon to re-mint and probe
      // configured service accounts. Previously these were two disconnected
      // paths, so the command printed "refreshed" while the Identity screen
      // remained permanently "NOT PROBED".
      const ctrl = await runtime.openController("", configFlag(root), false);
      try {
        // tokens.refresh(), not invalidate()+get() — invalidate() clears
        // every credential in the shared store, not just this one; refresh()
        // forces a fresh mint of only the user identity being checked here.
        const tok = await runtime.refreshUserToken("user");
        const daemonIdentity = ctrl.client ? await ctrl.refreshAuth() : undefined;
        if (opts.json) {
          writeOut(
            JSON.stringify(
              {
                identity: tok.identity,
                expires_at: tok.expiresAt.toISOString(),
                service_account_status: daemonIdentity?.service_account_status ?? {},
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }
        writeOut(`refreshed credentials expire ${tok.expiresAt.toISOString()}\n`);
        if (daemonIdentity) {
          for (const [email, status] of Object.entries(daemonIdentity.service_account_status).sort(([a], [b]) => a.localeCompare(b))) {
            writeOut(`service account ${email}: ${status}\n`);
          }
        }
      } finally {
        await ctrl.close();
      }
    });
}
