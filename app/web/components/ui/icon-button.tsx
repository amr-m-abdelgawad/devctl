import type { ReactNode } from "react";
import { Button, type ButtonProps } from "./button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

/** Icon-only button with a tooltip, so the action stays visible on hover. */
export function IconButton({
  label,
  side = "top",
  children,
  ...props
}: ButtonProps & { label: string; side?: "top" | "right" | "bottom" | "left"; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
