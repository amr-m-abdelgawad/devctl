import { useEffect, useRef, useState } from "react";
import { commandArguments } from "../command.ts";
import { useOperatorAction } from "../operator.ts";
import { ChoiceGroup, SearchInput } from "./filters.tsx";
import { ConfirmAction } from "./confirm-action.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Empty } from "./primitives.tsx";

type ExecResult = { code: number; stdout: string; stderr: string };
export function ServiceTools(props: { name: string; env?: string; configured: Record<string, string> }) {
  const { pending, error, run } = useOperatorAction();
  const generation = useRef(0);
  const [tab, setTab] = useState("environment");
  const [search, setSearch] = useState("");
  const [resolved, setResolved] = useState<Record<string, string>>();
  const [revealed, setRevealed] = useState(false);
  const [command, setCommand] = useState("");
  const [parseError, setParseError] = useState("");
  const [output, setOutput] = useState<ExecResult>();
  useEffect(() => {
    generation.current += 1;
    setResolved(undefined);
    setRevealed(false);
    setOutput(undefined);
  }, [props.name, props.env]);
  const environment = Object.entries(resolved ?? props.configured).filter(([key, value]) =>
    `${key} ${value}`.toLowerCase().includes(search.toLowerCase()),
  );
  const resolve = async (reveal = false): Promise<void> => {
    const gen = generation.current;
    const result = await run<{ environment: Record<string, string> }>("service_environment", {
      service: props.name,
      reveal,
      confirm: reveal,
    });
    if (result && gen === generation.current) {
      setResolved(result.environment);
      setRevealed(reveal);
    }
  };
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <ChoiceGroup
        label="Service tools"
        value={tab}
        onChange={setTab}
        options={[
          { value: "environment", label: "Environment" },
          { value: "exec", label: "Run command" },
        ]}
      />
      {tab === "environment" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {resolved ? "Resolved environment" : "Configured values"} · {revealed ? "secrets revealed" : "secrets redacted"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={Boolean(pending)} onClick={() => void resolve(false)}>
                {resolved ? "Refresh values" : "Resolve environment"}
              </Button>
              {revealed ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    setResolved(undefined);
                    setRevealed(false);
                  }}
                >
                  Hide secrets
                </Button>
              ) : (
                <ConfirmAction
                  label="Reveal values"
                  title="Reveal secret environment values?"
                  description={`Show resolved environment values for ${props.name} in this tab. Values are cleared when you close the inspector or change the environment overlay.`}
                  disabled={Boolean(pending)}
                  onConfirm={() => resolve(true)}
                />
              )}
            </div>
          </div>
          <SearchInput label="Find an environment variable" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          <div className="env-table">
            {environment.length ? (
              environment.map(([key, value]) => (
                <div key={key}>
                  <span className="break-all font-mono text-xs text-primary">{key}</span>
                  <span className="break-all font-mono text-xs text-muted-foreground">{value}</span>
                </div>
              ))
            ) : (
              <Empty>No environment variables match.</Empty>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Run a command with this service’s resolved environment and working directory. Quotes group arguments; commands run without shell
            expansion.
          </p>
          <label className="flex flex-col gap-2 text-xs">
            Command
            <Input
              value={command}
              onChange={(event) => {
                setCommand(event.currentTarget.value);
                setParseError("");
              }}
              placeholder="bun run db:migrate"
            />
          </label>
          <ConfirmAction
            label={pending ? "Running…" : "Review & run"}
            title={`Run a command in ${props.name}?`}
            description={<code className="break-all">{command}</code>}
            disabled={!command.trim() || Boolean(pending)}
            onConfirm={async () => {
              try {
                const args = commandArguments(command);
                const result = await run<ExecResult>("service_exec", { service: props.name, command: args, confirm: true });
                if (result) setOutput(result);
              } catch (err: unknown) {
                setParseError(err instanceof Error ? err.message : "Invalid command");
              }
            }}
          />
          {output ? (
            <div>
              <p className="mb-2 text-xs">Exit code: {output.code}</p>
              <div className="task-output">
                <pre>{output.stdout || "No standard output."}</pre>
                {output.stderr ? <pre className="text-destructive">{output.stderr}</pre> : null}
              </div>
            </div>
          ) : null}
        </>
      )}
      {error || parseError ? (
        <p role="alert" className="text-xs text-destructive">
          {error || parseError}
        </p>
      ) : null}
    </section>
  );
}
