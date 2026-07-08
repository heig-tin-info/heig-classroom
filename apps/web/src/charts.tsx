/**
 * Small dependency-free SVG charts for the student dashboard: a pass/fail
 * donut for CI checks and a color scale for the indicative grade. Chart
 * libraries (recharts, chart.js) drag their own theming and a lot of bundle
 * weight for two primitives; these stay on the design system.
 */

/** Swiss 1-6 grade from points/max, then a color band and a label. */
export function gradeToSix(points: number, max: number): number {
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
  if (n < 3.5) return { color: "#dc2626", label: "insufficient" };
  if (n < 4) return { color: "#f59e0b", label: "borderline" };
  if (n < 5) return { color: "#16a34a", label: "sufficient" };
  return { color: "#15803d", label: "strong" };
}

/** Pass/fail donut for CI checks. */
export function TestDonut({
  passed,
  total,
  size = 48,
}: {
  passed: number;
  total: number;
  size?: number;
}) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? passed / total : 0;
  const failColor = "#e5e7eb";
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={failColor} strokeWidth="4" className="dark:opacity-30" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={frac === 1 ? "#16a34a" : frac === 0 ? "#dc2626" : "#f59e0b"}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
        />
      </svg>
      <span className="absolute text-[0.7rem] font-semibold tabular-nums">
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
        className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
        style={{ backgroundColor: band.color }}
      >
        {points}/{max}
      </span>
      <span className="text-xs text-zinc-400">≈ {six.toFixed(1)}/6</span>
    </span>
  );
}
