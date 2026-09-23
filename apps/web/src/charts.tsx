/**
 * Small dependency-free SVG charts for the student dashboard: a pass/fail
 * donut for CI checks and a color scale for the indicative grade. Chart
 * libraries (recharts, chart.js) drag their own theming and a lot of bundle
 * weight for two primitives; these stay on the design system.
 */

/**
 * A GRADE out of 6 is already a Swiss mark: the score pipeline publishes
 * `mark/scale` with `scale: "6"`, both for the indicative tier and for the
 * LLM review. Converting it again turned a 2.8 into "≈ 3.3/6".
 */
export function isSwissMark(max: number): boolean {
  return max === 6;
}

/** Swiss 1-6 grade from points/max (as is when it already is one). */
export function gradeToSix(points: number, max: number): number {
  if (isSwissMark(max)) return points;
  if (max <= 0) return 1;
  return 1 + (points / max) * 5;
}

export interface GradeBand {
  color: string;
  label: string;
}

/**
 * 1.0-3.5 insufficient (red), 3.5-4.0 borderline (amber), 4.0-5.0 sufficient
 * (green), 5.0-6.0 strong (dark green).
 */
export function gradeBand(points: number, max: number): GradeBand {
  const n = gradeToSix(points, max);
  if (n < 3.5) return { color: "var(--danger)", label: "insufficient" };
  if (n < 4) return { color: "var(--warning)", label: "borderline" };
  if (n < 5) return { color: "var(--success)", label: "sufficient" };
  return { color: "var(--success)", label: "strong" };
}

/** Pass/fail donut for CI checks; the counter sits inside the ring. */
export function TestDonut({
  passed,
  total,
  size = 48,
}: {
  passed: number;
  total: number;
  size?: number;
}) {
  const stroke = Math.max(3, Math.round(size / 12));
  const r = size / 2 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? passed / total : 0;
  const failColor = "var(--surface-3)";
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={failColor} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={frac === 1 ? "var(--success)" : frac === 0 ? "var(--danger)" : "var(--warning)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
        />
      </svg>
      <span
        className="absolute font-bold tabular-nums tracking-tight"
        style={{ fontSize: Math.max(10, Math.round(size / 4.6)) }}
      >
        {passed}/{total}
      </span>
    </span>
  );
}

/** Grade chip colored by band; `n/max` plus the Swiss note. */
export function GradeScale({ points, max }: { points: number; max: number }) {
  const band = gradeBand(points, max);
  const six = gradeToSix(points, max);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex h-5.5 items-center rounded-full px-2 text-xs font-bold tabular-nums text-on-fill"
        style={{ backgroundColor: band.color }}
      >
        {points}/{max}
      </span>
      {isSwissMark(max) ? null : (
        <span className="whitespace-nowrap text-xs tabular-nums text-fg-faint">≈ {six.toFixed(1)}/6</span>
      )}
    </span>
  );
}
