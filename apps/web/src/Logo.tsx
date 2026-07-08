/**
 * Brand mark: the official GitHub Octocat wearing a graduation cap — the
 * platform is GitHub-backed coursework. The cat is the canonical
 * `mark-github` silhouette; a mortarboard and tassel sit on top, wider than
 * the head so the "hat" reads clearly even as a single-color silhouette on
 * the accent chip.
 */
export function OctocatGrad({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      {/* Official GitHub mark, scaled into the lower part of the frame. */}
      <g transform="translate(4 7.5) scale(0.9)">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </g>
      {/* Mortarboard board: a wide rhombus, brim extending past the head. */}
      <path d="M12 1.8 1.5 5.3 12 8.8 22.5 5.3 12 1.8Z" />
      {/* Tassel: cord draping off the right brim, ending in a small knob. */}
      <path
        d="M20.4 5.7c.6 1.4.9 2.6.4 4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.9"
        strokeLinecap="round"
      />
      <rect x="19.7" y="9.4" width="1.5" height="2.4" rx="0.7" />
    </svg>
  );
}
