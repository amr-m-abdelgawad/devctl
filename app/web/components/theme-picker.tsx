import { useState, type CSSProperties } from "react";
import { THEME_NAMES, resolveThemeName, themeBlurb, type ThemeName } from "../../src/domain/ui/themes.ts";
import { themeDefaultAppearance, themeLabel, webThemeTokens } from "../theme.ts";
import { CheckIcon } from "../icons.ts";
import { ChoiceGroup, SearchInput } from "./filters.tsx";
import { Badge } from "./ui/badge.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Empty } from "./primitives.tsx";

const CHOICES = THEME_NAMES.map((name) => {
  const appearance = themeDefaultAppearance(name);
  return { name, appearance, label: themeLabel(name), description: themeBlurb(name), tokens: webThemeTokens(name, appearance) };
});

export function ThemePicker(props: { value: string; disabled: boolean; onChange: (name: ThemeName) => void }) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState("all");
  const selected = resolveThemeName(props.value);
  const choices = CHOICES.filter(
    (choice) =>
      (mode === "all" || mode === choice.appearance) &&
      (choice.name + " " + choice.label + " " + choice.description).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="theme-picker">
      <div className="theme-picker-controls">
        <SearchInput label="Find a theme…" value={search} onChange={(event) => setSearch(event.currentTarget.value)} className="flex-1" />
        <ChoiceGroup
          label="Filter themes by appearance"
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: "All" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
        />
        <span className="text-xs text-muted-foreground" role="status">
          {choices.length} {choices.length === 1 ? "theme" : "themes"}
        </span>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={1}
        value={selected}
        disabled={props.disabled}
        onValueChange={(value) => {
          if (value) props.onChange(resolveThemeName(value));
        }}
        aria-label="Color theme"
        className="theme-grid"
      >
        {choices.map((choice) => (
          <ToggleGroupItem key={choice.name} value={choice.name} aria-label={choice.label} className="theme-option">
            <span
              className="theme-preview"
              aria-hidden="true"
              style={
                {
                  "--preview-bg": choice.tokens["--background"],
                  "--preview-card": choice.tokens["--card"],
                  "--preview-text": choice.tokens["--foreground"],
                  "--preview-muted": choice.tokens["--muted-foreground"],
                  "--preview-primary": choice.tokens["--primary"],
                } as CSSProperties
              }
            >
              <span className="theme-preview-sidebar">
                <i />
                <i />
                <i />
              </span>
              <span className="theme-preview-content">
                <span>
                  devctl <span>›_</span>
                </span>
                <span className="theme-preview-line" />
                <span className="theme-preview-line" />
                <span className="theme-preview-colors">
                  {["--primary", "--info", "--success", "--warning"].map((token) => (
                    <i key={token} style={{ backgroundColor: choice.tokens[token] }} />
                  ))}
                </span>
              </span>
            </span>
            <span className="theme-option-heading">
              <span>{choice.label}</span>
              {selected === choice.name ? <CheckIcon aria-hidden="true" /> : <Badge variant="muted">{choice.appearance}</Badge>}
            </span>
            <span className="theme-option-description">{choice.description}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {choices.length === 0 ? <Empty>No themes match. Try another name or appearance.</Empty> : null}
    </div>
  );
}
