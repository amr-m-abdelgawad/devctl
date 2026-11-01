// Adapted from BlackisPlay’s MIT-licensed loader. See THIRD_PARTY_NOTICES.md.
export function GhostLoader() {
  return (
    <svg className="ghost-loader" viewBox="0 0 18 20" width="112" height="128" aria-hidden="true" shapeRendering="crispEdges">
      <ellipse className="ghost-loader-shadow" cx="9" cy="18" rx="6" ry="0.7" />
      <g className="ghost-loader-body">
        <path fill="var(--primary)" d="M7 2h4v1h2v1h1v1h1v3h1v6H2V8h1V5h1V4h1V3h2Z" />
        {/* Overlap the body by one pixel to prevent seams at fractional zoom levels. */}
        <path className="ghost-loader-feet-a" fill="var(--primary)" d="M2 13h3v2H2Zm5 0h4v2H7Zm6 0h3v2h-3Z" />
        <path className="ghost-loader-feet-b" fill="var(--primary)" d="M4 13h3v2H4Zm7 0h3v2h-3Z" />
        <path fill="var(--foreground)" d="M4 5h2v1h1v3H6v1H4V9H3V6h1Zm6 0h2v1h1v3h-1v1h-2V9H9V6h1Z" />
        <g className="ghost-loader-pupils" fill="var(--background)">
          <path d="M3 7h2v2H3Zm6 0h2v2H9Z" />
        </g>
      </g>
    </svg>
  );
}
