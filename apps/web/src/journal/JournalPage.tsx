import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, EyeOff, FileText, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";

import "katex/dist/katex.min.css";

import type { JournalPage as JournalPageData, JournalPayload } from "@hgc/contracts";

import { api, apiErrorMessage } from "../api";
import { Breadcrumb } from "../Breadcrumb";
import { useT } from "../i18n";
import { useToast } from "../notify";
import type { Route } from "../router";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  formatDateTimeAs,
  QueryError,
  Skeleton,
  cx,
} from "../ui";
import { JournalBody } from "./JournalBody";
import { encodePath, JournalEditor } from "./JournalEditor";
import { JournalNav } from "./JournalNav";

/*
 * The journal of a classroom, read (issue #45).
 *
 * The one screen of the product that serves BOTH audiences: a student reads it
 * and a teacher reads and writes it, from the same route and the same payload —
 * the server decides which, so there is no second place to forget that a draft
 * is not for students.
 *
 * The four decisions:
 * - Type: the page owns its title, inside `.md-body` at the 28 px step. The
 *   navigation is 13 px dense UI. The contrast is that size jump and nothing
 *   else.
 * - Color: ONE accent, the current page in the navigation. `Edit` is the only
 *   accent CONTROL, and only for staff. Strip the red and the current page is
 *   still the filled row.
 * - Space: 4–8 between navigation rows, 32 between the navigation column and
 *   the page, 24 under the header, 1.75 leading inside the prose.
 * - Finish: the page is a sheet of paper (`surface`, hairline, card radius) on
 *   the warm canvas; the navigation is a bare column beside it. No shadow.
 *
 * It is a student surface, so every string goes through `t()` — except the
 * staff-only controls, which stay in English like every other teacher surface.
 */
export function JournalPage({
  classroomId,
  pagePath,
  navigate,
  readOnly = false,
}: {
  classroomId: string;
  /** Journal-relative path; empty means the front page. */
  pagePath: string;
  navigate: (r: Route) => void;
  /** A teacher looking through the student view: no writing from here. */
  readOnly?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const base = `/app/api/classrooms/${classroomId}/journal`;
  const toast = useToast();

  const journal = useQuery<JournalPayload>({
    queryKey: ["journal", classroomId],
    queryFn: () => api(base),
  });

  // The front page when no page is named, so `/classrooms/x/journal/` opens
  // something rather than nothing.
  const target = pagePath || journal.data?.homePath || "";
  const page = useQuery<JournalPageData>({
    queryKey: ["journal-page", classroomId, target],
    queryFn: () => api(`${base}/pages/${encodePath(target)}`),
    enabled: target !== "",
  });

  // Re-reads the repository on demand, for when a webhook was missed. A
  // mutation and not a bare `await` in the handler: it has a busy state, and a
  // failure has to say so rather than vanish into an unhandled rejection.
  const refresh = useMutation({
    mutationFn: () => api(`${base}/refresh`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["journal", classroomId] });
      await qc.invalidateQueries({ queryKey: ["journal-page", classroomId] });
    },
    onError: (err) => toast(apiErrorMessage(err, "The refresh failed"), "error"),
  });

  const staff = (journal.data?.staff ?? false) && !readOnly;
  // Only the staff payload carries them, which is exactly when the marks show.
  const hiddenPaths = new Set(journal.data?.hiddenPaths ?? []);

  const open = (next: string) =>
    navigate({ view: "journal", classroomId, pagePath: next });

  if (journal.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }
  if (journal.isError) {
    return (
      <QueryError
        title={t("journal.loadError")}
        error={journal.error}
        onRetry={() => void journal.refetch()}
      />
    );
  }

  const data = journal.data!;
  const empty = data.nav.length === 0 && data.homePath === null;

  return (
    <div className="space-y-6">
      {/* No page title here on purpose: the DOCUMENT owns its title, at the
          28 px step inside `.md-body`. A "Journal" heading above it would put
          two page titles on one screen and neither would win the squint test.
          What is left is where you are, when it was last touched, and what you
          can do about it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <Breadcrumb
            items={[
              {
                label: data.classroomName,
                onClick: () =>
                  navigate(
                    data.staff ? { view: "classroom", id: classroomId } : { view: "home" },
                  ),
              },
              { label: t("journal.title") },
            ]}
          />
          {page.data?.updatedAt ? (
            <p className="mt-1 text-xs text-fg-faint">
              {t("journal.updated", { date: formatDateTimeAs(page.data.updatedAt, "eu") })}
            </p>
          ) : null}
        </div>
        {staff && data.journal ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw /> Refresh
            </Button>
            {page.data && !editing ? (
              <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {data.journal?.syncStatus === "error" && staff ? (
        <Alert tone="danger" title="The journal could not be read from GitHub">
          {data.journal.syncError}
        </Alert>
      ) : null}

      {empty ? (
        <EmptyState icon={BookOpen} title={t("journal.empty")}>
          {t("journal.emptyHint")}
        </EmptyState>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <nav aria-label={t("journal.nav")} className="lg:sticky lg:top-6 lg:self-start">
            {data.homePath ? (
              <button
                type="button"
                onClick={() => open(data.homePath!)}
                aria-current={target === data.homePath ? "page" : undefined}
                className={cx(
                  "mb-2 flex w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-left text-[13px] transition-colors",
                  target === data.homePath
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <BookOpen className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t("journal.home")}</span>
              </button>
            ) : null}
            <JournalNav
              nodes={data.nav}
              current={target}
              hiddenPaths={hiddenPaths}
              onOpen={open}
            />
          </nav>

          <div className="min-w-0">
            {page.isLoading ? (
              <div className="space-y-3 rounded-card border border-line bg-surface p-6">
                <Skeleton className="h-7 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : page.isError || !page.data ? (
              <EmptyState icon={FileText} title={t("journal.notFound")}>
                {t("journal.notFoundHint")}
              </EmptyState>
            ) : editing && staff ? (
              <JournalEditor
                classroomId={classroomId}
                page={page.data}
                navigate={navigate}
                onSaved={async () => {
                  setEditing(false);
                  await qc.invalidateQueries({ queryKey: ["journal", classroomId] });
                  await qc.invalidateQueries({ queryKey: ["journal-page", classroomId, target] });
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <article className="rounded-card border border-line bg-surface px-6 py-6 sm:px-8">
                {page.data.hidden ? (
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <Badge tone="amber">
                      <EyeOff className="size-3" aria-hidden /> {t("journal.hidden")}
                    </Badge>
                    {page.data.draft ? <Badge tone="zinc">{t("journal.draft")}</Badge> : null}
                    {page.data.visibleFrom ? (
                      <span className="text-xs text-fg-muted">
                        {t("journal.visibleFrom", {
                          date: formatDateTimeAs(page.data.visibleFrom, "eu"),
                        })}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {staff && (page.data.warnings?.length ?? 0) > 0 ? (
                  <Alert tone="warning" title="This page has warnings">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {page.data.warnings!.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}
                <JournalBody html={page.data.html} navigate={navigate} />
              </article>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
