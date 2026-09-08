import { defaultStarterAnswers, parseProxyPort, SETUP_FIELDS, type SetupField, type StarterAnswers } from "../../../application/setup-starter.ts";
import { KeyHints, OverlayShell } from "../layout.tsx";
import { type Palette } from "../themes.ts";

export function SetupWizardOverlay(props: {
  palette: Palette;
  termW: number;
  termH: number;
  step: number;
  answers: StarterAnswers;
  repo: string;
  draft: string;
  authStatus: string;
  onDraft: (value: string) => void;
  onSubmit: () => void;
}) {
  const { palette, termW, termH, step, answers, repo, draft, authStatus, onDraft, onSubmit } = props;
  const field: SetupField = SETUP_FIELDS[step] ?? SETUP_FIELDS[0]!;
  const total = SETUP_FIELDS.length;
  const hint = fieldHint(field.id, answers, repo);
  return (
    <OverlayShell
      palette={palette}
      title={`setup  ${step + 1}/${total}  ${field.title}`}
      bottomTitle="enter next  ·  esc cancel"
      termW={termW}
      termH={termH}
      preferW={64}
      preferH={12}
      borderColor={palette.primary}
      gap={1}
    >
      <text fg={palette.muted} wrapMode="word">
        {hint}
      </text>
      {field.id === "auth" || field.id === "write" || field.id === "repo" ? (
        <text fg={palette.text} wrapMode="word">
          {field.id === "auth" ? authStatus : field.id === "repo" ? repo : "Write .devctl/config.yaml and attach the daemon."}
        </text>
      ) : (
        <input
          focused
          value={draft}
          placeholder={field.prompt}
          onInput={onDraft}
          onSubmit={onSubmit}
          backgroundColor={palette.element}
          focusedBackgroundColor={palette.element}
          textColor={palette.text}
          cursorColor={palette.primary}
        />
      )}
      <KeyHints
        palette={palette}
        hints={[
          { key: "enter", label: field.id === "write" ? "write and attach" : "next" },
          { key: "esc", label: "cancel" },
        ]}
      />
    </OverlayShell>
  );
}

export function setupWizardDraft(field: SetupField["id"], answers: StarterAnswers, repo: string): string {
  if (field === "name") {
    return answers.name;
  }
  if (field === "project") {
    return answers.project;
  }
  if (field === "sa") {
    return answers.sa;
  }
  if (field === "audience") {
    return answers.audience;
  }
  if (field === "port") {
    return String(answers.proxyPort);
  }
  if (field === "profile") {
    return answers.profile;
  }
  if (field === "repo") {
    return repo;
  }
  return "";
}

export function applySetupDraft(field: SetupField["id"], answers: StarterAnswers, draft: string, repo: string): StarterAnswers {
  const next = { ...answers };
  if (field === "name") {
    next.name = draft.trim() || defaultStarterAnswers(repo).name;
  } else if (field === "project") {
    next.project = draft.trim();
  } else if (field === "sa") {
    next.sa = draft.trim();
  } else if (field === "audience") {
    next.audience = draft.trim();
  } else if (field === "port") {
    next.proxyPort = parseProxyPort(draft, answers.proxyPort);
  } else if (field === "profile") {
    next.profile = draft.trim();
  }
  return next;
}

function fieldHint(id: SetupField["id"], answers: StarterAnswers, repo: string): string {
  if (id === "repo") {
    return `Using ${repo}. The TUI always writes under this checkout.`;
  }
  if (id === "auth") {
    return "ADC login needs a real TTY. Enter continues; if ADC is missing, login runs gcloud on the terminal.";
  }
  if (id === "write") {
    return `Project ${answers.name || "(unnamed)"}. Enter writes the starter file and attaches the daemon.`;
  }
  return SETUP_FIELDS.find((field) => field.id === id)?.prompt ?? "";
}
