import type { SVGProps } from "react";

/** Same geometry as `docs/public/logo.svg`. Colors follow the active web theme. */
export function DevctlLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={32} height={32} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      <rect
        x="1.5"
        y="1.5"
        width="29"
        height="29"
        rx="7"
        fill="var(--logo-plate, #18372f)"
        stroke="var(--logo-stroke, #087568)"
        strokeWidth="1.5"
      />
      <path
        d="M8 11l5 5-5 5"
        stroke="var(--logo-mark, #77ddba)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15.5" y="19.6" width="8.5" height="2.4" rx="1.2" fill="var(--logo-mark, #77ddba)" />
    </svg>
  );
}
