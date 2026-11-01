import { ArrowUpRightIcon, BugIcon, CaretDownIcon, GithubLogoIcon, LightbulbIcon, StarIcon } from "../icons.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

// The asset build keeps only github.com/amr-m-abdelgawad/devctl/ links, so the slash is required.
const REPO_URL = "https://github.com/amr-m-abdelgawad/devctl/";

const FEEDBACK_LINKS = [
  { label: "Star the repo", href: REPO_URL, icon: StarIcon },
  { label: "Report a bug", href: "https://github.com/amr-m-abdelgawad/devctl/issues/new?template=bug.md", icon: BugIcon },
  { label: "Share an idea", href: "https://github.com/amr-m-abdelgawad/devctl/discussions/new?category=ideas", icon: LightbulbIcon },
];

// Expanding icon panel adapted from AKAspidey01. See THIRD_PARTY_NOTICES.md.
export function FeedbackMenu({ compact = false }: { compact?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="feedback-trigger" data-compact={compact} aria-label="Feedback on GitHub" title={compact ? "Feedback on GitHub" : undefined}>
          <span className="feedback-icon-panel" aria-hidden="true"><GithubLogoIcon weight="fill" /></span>
          <span className="feedback-trigger-copy">Feedback <CaretDownIcon aria-hidden="true" /></span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? "right" : "top"} align="start" sideOffset={8} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Feedback on GitHub</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {FEEDBACK_LINKS.map(({ label, href, icon: Icon }) => (
            <DropdownMenuItem key={label} asChild>
              <a href={href} target="_blank" rel="noopener noreferrer">
                <Icon aria-hidden="true" />
                <span>{label}</span>
                <ArrowUpRightIcon className="ml-auto" aria-hidden="true" />
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
