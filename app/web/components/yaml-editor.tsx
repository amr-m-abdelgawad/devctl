import CodeMirror from "@uiw/react-codemirror";
import { indentUnit } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { cn } from "../lib/utils.ts";

const yamlExtensions = [yaml(), indentUnit.of("  ")];

export function YamlEditor(props: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  label: string;
  invalid?: boolean;
  placeholder?: string;
  height?: string;
}) {
  return (
    <div className={cn("code-editor", props.invalid && "code-editor-invalid")}>
      <CodeMirror
        value={props.value}
        height={props.height ?? "420px"}
        theme="dark"
        indentWithTab
        extensions={yamlExtensions}
        editable={!props.readOnly}
        readOnly={Boolean(props.readOnly)}
        placeholder={props.placeholder}
        aria-label={props.label}
        aria-invalid={props.invalid || undefined}
        onChange={(value) => props.onChange?.(value)}
      />
    </div>
  );
}
