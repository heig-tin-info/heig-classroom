/**
 * Brand mark: a cat (nodding to GitHub's octocat) wearing a graduation cap —
 * the platform is GitHub-backed coursework. Drawn as a monochrome silhouette
 * in `currentColor` so it sits on the accent chip like the rest of the icons;
 * the eyes are punched out in the chip color.
 */
export function OctocatGrad({
  className = "size-6",
  eye = "var(--color-accent, #b41f24)",
}: {
  className?: string;
  eye?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      {/* Head with two ears. */}
      <path
        d="M6.9 11.5 6 8.4c-.1-.35.28-.63.6-.44l2.53 1.5a6.8 6.8 0 0 1 1.87-.26h.02c.64 0 1.27.09 1.86.26l2.53-1.5c.32-.19.7.09.6.44l-.9 3.1c.5.72.79 1.57.79 2.53 0 3.2-2.6 4.37-5.87 4.37S6.1 17.23 6.1 14.03c0-.96.29-1.81.8-2.53Z"
        fill="currentColor"
      />
      {/* Eyes punched out in the chip color. */}
      <circle cx="10.1" cy="14.2" r="1" fill={eye} />
      <circle cx="13.9" cy="14.2" r="1" fill={eye} />
      {/* Graduation cap: mortarboard + tassel, sitting on the head. */}
      <path d="M12 3.2 3.4 6.5 12 9.8l8.6-3.3L12 3.2Z" fill="currentColor" />
      <path
        d="M20.6 6.5v3.1"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <circle cx="20.6" cy="10" r="0.85" fill="currentColor" />
    </svg>
  );
}
