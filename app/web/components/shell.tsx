import { Fragment, useEffect, useState, type ReactNode } from "react";
import { DevctlLogo } from "../brand.tsx";
import { hrefFor } from "../hash.ts";
import {
  ArrowsLeftRightIcon,
  ArrowClockwiseIcon,
  ArrowUpRightIcon,
  BrowsersIcon,
  CommandIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretDownIcon,
  FileCodeIcon,
  FirstAidIcon,
  FlowArrowIcon,
  GearIcon,
  GraphIcon,
  GaugeIcon,
  IdentificationCardIcon,
  ListIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  ScrollIcon,
  SquaresFourIcon,
  StackIcon,
  type Icon,
} from "../icons.ts";
import { cn } from "../lib/utils.ts";
import type { RouteName, ServiceRow, StatusSummary } from "../types.ts";
import { Button } from "./ui/button.tsx";
import { IconButton } from "./ui/icon-button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { SearchInput } from "./filters.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu.tsx";

const SIDEBAR_KEY = "devctl.sidebar.collapsed";
function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "true";
  } catch {
    return false;
  }
}

const PAGES: Array<{ name: RouteName; label: string; description: string; icon: Icon; group: string }> = [
  {
    name: "services",
    label: "Overview",
    description: "Your services, health, and recent activity.",
    icon: SquaresFourIcon,
    group: "Workspace",
  },
  {
    name: "workspace",
    label: "Profiles & tasks",
    description: "Start a working set or run a one-off task.",
    icon: StackIcon,
    group: "Workspace",
  },
  {
    name: "graph",
    label: "Topology & metrics",
    description: "Follow dependencies and watch the stack’s live signals.",
    icon: GraphIcon,
    group: "Workspace",
  },
  {
    name: "system",
    label: "System & supervisor",
    description: "Service resources, supervisor logs, updates, and session controls.",
    icon: GaugeIcon,
    group: "Workspace",
  },
  { name: "logs", label: "Logs", description: "Search, filter, and follow logs across your services.", icon: ScrollIcon, group: "Observe" },
  { name: "traces", label: "Traces", description: "Follow a request through your services.", icon: FlowArrowIcon, group: "Observe" },
  {
    name: "traffic",
    label: "Traffic",
    description: "Inspect captured HTTP and gRPC requests.",
    icon: ArrowsLeftRightIcon,
    group: "Observe",
  },
  { name: "llm", label: "LLM calls", description: "Explore model calls, conversations, and usage.", icon: RobotIcon, group: "Observe" },
  {
    name: "proxy",
    label: "Proxy & connections",
    description: "Manage proxy routes, listeners, and coding-agent connections.",
    icon: BrowsersIcon,
    group: "Manage",
  },
  {
    name: "config",
    label: "Configuration",
    description: "Edit, validate, and inspect your workspace configuration.",
    icon: FileCodeIcon,
    group: "Manage",
  },
  { name: "doctor", label: "Doctor", description: "Check your environment and resolve setup issues.", icon: FirstAidIcon, group: "Manage" },
  {
    name: "identity",
    label: "Identity",
    description: "Sign in and manage credentials, tokens, and service account access.",
    icon: IdentificationCardIcon,
    group: "Manage",
  },
  { name: "settings", label: "Settings", description: "Make this workspace work for you.", icon: GearIcon, group: "Manage" },
];

export function ConsoleShell(props: {
  route: RouteName;
  project: string;
  status?: StatusSummary;
  services: ServiceRow[];
  busy: boolean;
  error: string;
  onReload: () => void;
  notice: ReactNode;
  update: ReactNode;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const page = PAGES.find((item) => item.name === props.route) ?? PAGES[0]!;
  useEffect(() => {
    setMenu(false);
  }, [props.route]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const nav = (
    <nav aria-label="Main navigation" className="console-nav">
      {["Workspace", "Observe", "Manage"].map((group) => (
        <div key={group} className="nav-group">
          <p className="nav-label">{group}</p>
          {PAGES.filter((item) => item.group === group).map((item) => {
            const link = (
              <a
                href={hrefFor(item.name)}
                aria-label={item.label}
                aria-current={props.route === item.name ? "page" : undefined}
                className={cn("nav-link", props.route === item.name && "nav-link-active")}
                onClick={() => setMenu(false)}
              >
                <item.icon aria-hidden="true" />
                <span className="nav-link-label">{item.label}</span>
                {item.name === "services" ? <span className="nav-count">{props.services.length}</span> : null}
              </a>
            );
            // Mount tooltips only while the rail is collapsed. Hovering the expanded
            // labels otherwise leaves every trigger open, and they all appear on collapse.
            if (!collapsed) return <Fragment key={item.name}>{link}</Fragment>;
            return (
              <Tooltip key={item.name}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right" align="center" sideOffset={8} avoidCollisions={false}>
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </nav>
  );
  return (
    <div className={cn("console-layout", collapsed && "console-collapsed")}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <aside id="workspace-sidebar" className="console-sidebar">
        <div className="sidebar-heading">
          <a
            href={hrefFor("services")}
            className="console-brand"
            aria-label="devctl overview"
            title={collapsed ? props.project : undefined}
          >
            <DevctlLogo className="size-8" />
            <span className="brand-copy">
              <span className="brand-name">devctl</span>
              <span className="brand-caption">DEVELOPMENT CONSOLE</span>
            </span>
          </a>
          <IconButton
            variant="ghost"
            size="icon"
            className="sidebar-toggle"
            side={collapsed ? "right" : "bottom"}
            label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            aria-controls="workspace-sidebar"
            onClick={() => {
              const next = !collapsed;
              setCollapsed(next);
              try {
                window.localStorage.setItem(SIDEBAR_KEY, String(next));
              } catch {
                /* Keep the control usable when storage is unavailable. */
              }
            }}
          >
            {collapsed ? <CaretRightIcon /> : <CaretLeftIcon />}
          </IconButton>
        </div>
        <div className="workspace-label">
          <span className="size-2 shrink-0 rounded-sm bg-primary" />
          <span className="truncate" title={props.status?.repo_root}>
            {props.project || "Local workspace"}
          </span>
        </div>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="sidebar-search mx-4 justify-between"
                aria-label="Quick find"
                onClick={() => {
                  setSearch("");
                  setSearchOpen(true);
                }}
              >
                <span className="flex items-center gap-2">
                  <MagnifyingGlassIcon data-icon="inline-start" />
                  Quick find
                </span>
                <kbd className="text-[10px]">⌘ K</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Quick find</TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="outline"
            className="sidebar-search mx-4 justify-between"
            aria-label="Quick find"
            onClick={() => {
              setSearch("");
              setSearchOpen(true);
            }}
          >
            <span className="flex items-center gap-2">
              <MagnifyingGlassIcon data-icon="inline-start" />
              Quick find
            </span>
            <kbd className="text-[10px]">⌘ K</kbd>
          </Button>
        )}
        {nav}
        <div
          className="sidebar-footer"
          title={props.error ? "Connection interrupted" : props.status ? "Connected to supervisor" : "Connecting…"}
        >
          <span className={cn("size-1.5 rounded-full", props.error ? "bg-warning" : props.status ? "bg-success" : "bg-muted-foreground")} />
          <span>{props.error ? "Connection interrupted" : props.status ? "Connected to supervisor" : "Connecting…"}</span>
        </div>
      </aside>
      <div className="console-workspace">
        <header className="console-topbar">
          <IconButton variant="ghost" size="icon" className="lg:hidden" label="Open navigation" onClick={() => setMenu(true)}>
            <ListIcon />
          </IconButton>
          <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
            <span className="hidden sm:inline">
              {props.project || "Workspace"}
              <span className="mx-2.5 text-border">/</span>
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="max-w-full min-w-0 px-2" aria-label={`Switch page: ${page.label}`}>
                  <page.icon data-icon="inline-start" aria-hidden="true" />
                  <span className="truncate">{page.label}</span>
                  <CaretDownIcon data-icon="inline-end" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {["Workspace", "Observe", "Manage"].map((group, index) => (
                  <DropdownMenuGroup key={group}>
                    {index ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuLabel>{group}</DropdownMenuLabel>
                    {PAGES.filter((item) => item.group === group).map((item) => (
                      <DropdownMenuItem key={item.name} asChild>
                        <a href={hrefFor(item.name)} aria-current={props.route === item.name ? "page" : undefined}>
                          <item.icon aria-hidden="true" />
                          <span>{item.label}</span>
                        </a>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <span className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex">
            <span
              className={cn("size-1.5 rounded-full", props.error ? "bg-warning" : props.status ? "bg-success" : "bg-muted-foreground")}
            />
            {props.error ? "Reconnecting" : props.status ? "Live · 2s" : "Connecting"}
          </span>
          <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onReload} title="Reload configuration">
            <ArrowClockwiseIcon data-icon="inline-start" />
            <span className="hidden sm:inline">Reload config</span>
          </Button>
          <IconButton
            size="icon"
            variant="ghost"
            className="lg:hidden"
            label="Quick find"
            onClick={() => {
              setSearch("");
              setSearchOpen(true);
            }}
          >
            <MagnifyingGlassIcon />
          </IconButton>
        </header>
        {props.update}
        {props.error ? (
          <div className="connection-notice" role="alert">
            {props.error}
          </div>
        ) : null}
        <main id="main-content" className="console-main" aria-busy={props.busy} tabIndex={-1}>
          <div className="page-heading">
            <div className="page-heading-main">
              <p className="page-eyebrow">{page.group}</p>
              <span className="page-title-icon" aria-hidden="true">
                <page.icon />
              </span>
              <h1 className="page-title">{page.label}</h1>
              <p className="page-description">{page.description}</p>
            </div>
            <div className="page-context">
              <span className="status-signal" />
              {props.status?.profile || "No active profile"}
            </div>
          </div>
          {props.children}
        </main>
        <div className="control-notice" role="status" aria-live="polite">
          {props.notice}
        </div>
      </div>
      <Dialog open={menu} onOpenChange={setMenu}>
        <DialogContent className="nav-dialog">
          <DialogHeader>
            <DialogTitle>devctl workspace</DialogTitle>
            <DialogDescription>{props.project || "Local workspace"}</DialogDescription>
          </DialogHeader>
          {nav}
        </DialogContent>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="quick-find-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CommandIcon />
              Quick find
            </DialogTitle>
            <DialogDescription>Jump to a page or inspect a service. Use Tab to choose a result.</DialogDescription>
          </DialogHeader>
          <SearchInput
            label="Search pages and services"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            autoFocus
          />
          <div className="quick-results">
            <p className="nav-label">Pages</p>
            {PAGES.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(search.toLowerCase())).map((item) => (
              <a key={item.name} href={hrefFor(item.name)} onClick={() => setSearchOpen(false)}>
                <item.icon />
                <span>{item.label}</span>
                <ArrowUpRightIcon />
              </a>
            ))}
            <p className="nav-label">Services</p>
            {props.services
              .filter((service) => service.name.toLowerCase().includes(search.toLowerCase()))
              .slice(0, 40)
              .map((service) => (
                <a key={service.name} href={hrefFor("services", service.name)} onClick={() => setSearchOpen(false)}>
                  <StackIcon />
                  <span>{service.name}</span>
                  <small>{service.state.toLowerCase()}</small>
                </a>
              ))}
            {search &&
            !PAGES.some((item) => `${item.label} ${item.description}`.toLowerCase().includes(search.toLowerCase())) &&
            !props.services.some((service) => service.name.toLowerCase().includes(search.toLowerCase())) ? (
              <p className="p-4 text-sm text-muted-foreground">No pages or services match “{search}”.</p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
