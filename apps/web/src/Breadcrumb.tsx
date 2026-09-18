import { ChevronRight } from "lucide-react";

/** Page-level breadcrumb, the eyebrow of a page header: where this page sits. */
export function Breadcrumb({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[13px]">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? <ChevronRight className="size-3.5 text-fg-faint" /> : null}
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className="rounded-sm text-fg-muted transition-colors hover:text-fg"
            >
              {item.label}
            </button>
          ) : (
            <span className="text-fg-muted">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
