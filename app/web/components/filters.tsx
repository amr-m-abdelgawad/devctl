import { useState, type ComponentProps, type ReactNode } from "react";
import { CaretDownIcon, MagnifyingGlassIcon, PauseIcon, PlayIcon, XIcon } from "../icons.ts";
import { cn } from "../lib/utils.ts";
import { Input } from "./ui/input.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";

export function SearchInput({ label, className, ...props }: ComponentProps<"input"> & { label: string }) {
  return (
    <label className={cn("search-field relative block min-w-0", className)}>
      <span className="sr-only">{label}</span>
      <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" className="pl-9" placeholder={label} {...props} />
    </label>
  );
}

export function FilterSelect(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("filter-select min-w-0", props.className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={props.disabled} aria-label={props.label} className="w-full min-w-0 justify-between">
            <span className="truncate">
              {props.options.find((option) => option.value === props.value)?.label || props.value || props.label}
            </span>
            <CaretDownIcon data-icon="inline-end" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-1rem)]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{props.label}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={props.value} onValueChange={props.onChange}>
              {props.options.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ChoiceGroup(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: ReactNode }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value) props.onChange(value);
      }}
    >
      {props.options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={typeof option.label === "string" ? option.label : option.value}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function SearchableFilter(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; count?: number }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options = props.options.filter((option) => option.label.toLowerCase().includes(search.toLowerCase()));
  const current = props.options.find((option) => option.value === props.value);
  return (
    <>
      <Button
        variant="outline"
        className="max-w-full justify-start"
        aria-label={`${props.label}: ${current?.label || props.value || "All"}`}
        onClick={() => {
          setSearch("");
          setOpen(true);
        }}
      >
        <span className="truncate">{current?.label || props.value || "All"}</span>
        <MagnifyingGlassIcon data-icon="inline-end" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{props.label}</DialogTitle>
            <DialogDescription>Search the list to narrow this view.</DialogDescription>
          </DialogHeader>
          <SearchInput
            label={`Find ${props.label.toLowerCase()}`}
            value={search}
            autoFocus
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          <div className="picker-results">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={option.value === props.value}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {option.count !== undefined ? (
                  <small className="font-mono text-muted-foreground">{option.count.toLocaleString()}</small>
                ) : null}
              </button>
            ))}
            {options.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No matches.</p> : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type FeedControls = { paused: boolean; loadingMore: boolean; loadMore: () => void; togglePause: () => void };

export function InspectorFilters(props: {
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
  caller: string;
  callers: string[];
  onCaller: (value: string) => void;
  filters: Record<string, string>;
  onFilters: (value: Record<string, string>) => void;
  fields: Array<{ key: string; label: string; values: string[] }>;
  feed: FeedControls;
}) {
  const active = props.caller || props.search || Object.values(props.filters).some(Boolean);
  return (
    <div className="inspector-filters">
      <SearchInput label={props.placeholder} value={props.search} onChange={(event) => props.onSearch(event.currentTarget.value)} />
      <SearchableFilter
        label="Caller"
        value={props.caller}
        onChange={props.onCaller}
        options={[
          { value: "", label: "All callers" },
          ...props.callers.map((value) => ({ value, label: value })),
          { value: "-", label: "No caller" },
        ]}
      />
      <FilterSelect
        label="Call status"
        value={props.filters.status || ""}
        onChange={(status) => props.onFilters({ ...props.filters, status })}
        options={[
          { value: "", label: "All statuses" },
          { value: "ok", label: "Successful" },
          { value: "error", label: "Errors" },
        ]}
      />
      {props.fields.map((field) => (
        <FilterSelect
          key={field.key}
          label={field.label}
          value={props.filters[field.key] || ""}
          onChange={(value) => props.onFilters({ ...props.filters, [field.key]: value })}
          options={[
            { value: "", label: field.label },
            ...[...new Set([...field.values, props.filters[field.key] || ""])].filter(Boolean).map((value) => ({ value, label: value })),
          ]}
        />
      ))}
      <Button variant={props.feed.paused ? "secondary" : "outline"} onClick={props.feed.togglePause}>
        {props.feed.paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
        {props.feed.paused ? "Back to live" : "Pause"}
      </Button>
      {active ? (
        <Button
          variant="ghost"
          onClick={() => {
            props.onSearch("");
            props.onCaller("");
            props.onFilters({});
          }}
        >
          <XIcon data-icon="inline-start" />
          Reset
        </Button>
      ) : null}
    </div>
  );
}
