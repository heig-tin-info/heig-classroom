import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  EyeOff,
  FilePlus2,
  FileText,
  Link2,
  RefreshCw,
  Terminal,
  Unlink,
} from "lucide-react";
import { useState } from "react";

import type { JournalNavNode, JournalPayload } from "@hgc/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useToast } from "../notify";
import type { Route } from "../router";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  GithubIcon,
  Menu,
  Modal,
  QueryError,
  SectionHeading,
  Skeleton,
  cx,
  formatDateTimeAs,
  type MenuItem,
} from "../ui";

/*
 * The Journal tab of a classroom: the MANAGE surface (issue #45). A teacher
 * screen, so English throughout.
 *
 * Reading and writing a page happen on the journal's own route — a student
 * reads it too, and a page path does not fit in a `?tab=` — so this tab does
 * what the assignments tab does: it lists what is there, says what state it is
 * in, and opens it. Nothing is rendered twice.
 *
 * The four decisions:
 * - Type: the section heading step (16) over 13 px rows; the repository name is
 *   mono, because it is a thing you clone.
 * - Color: ONE accent, `Create the journal` in the empty state — and once the
 *   journal exists, nothing on this tab is accent: it is a status panel, and
 *   the writing happens on the page itself.
 * - Space: 4 between rows, 16 inside the card, 24 between the status and the
 *   page list.
 * - Finish: hairlines and `surface-2`. No shadow in the page flow.
 */

/** Flattens the navigation into the reading order, with its depth. */
function flatten(nodes: JournalNavNode[], depth = 0): { node: JournalNavNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

export function JournalTab({
  classroomId,
  navigate,
}: {
  classroomId: string;
  navigate: (r: Route) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const base = `/app/api/classrooms/${classroomId}/journal`;
  const [creating, setCreating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [adding, setAdding] = useState(false);

  const journal = useQuery<JournalPayload>({
    queryKey: ["journal", classroomId],
    queryFn: () => api(base),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["journal", classroomId] });

  const refresh = useMutation({
    mutationFn: () => api(`${base}/refresh`, { method: "POST" }),
    onSuccess: async () => {
      await invalidate();
      await qc.invalidateQueries({ queryKey: ["journal-page", classroomId] });
      toast("Journal refreshed from GitHub", "success");
    },
    onError: (err) => toast(apiErrorMessage(err, "The refresh failed"), "error"),
  });

  const detach = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: async () => {
      await invalidate();
      toast("Journal detached. The repository was not touched.", "success");
    },
    onError: (err) => toast(apiErrorMessage(err, "The journal could not be detached"), "error"),
  });

  if (journal.isLoading) return <Skeleton className="h-48 w-full" />;
  if (journal.isError) {
    return (
      <QueryError
        title="The journal could not be loaded"
        error={journal.error}
        onRetry={() => void journal.refetch()}
      />
    );
  }
  const data = journal.data!;

  if (!data.journal) {
    return (
      <>
        <Card className="px-6 py-4">
          <EmptyState
            icon={BookOpen}
            title="No journal yet"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="primary"
                  disabled={data.appInstalled === false}
                  onClick={() => setCreating(true)}
                >
                  <BookOpen /> Create the journal
                </Button>
                <Button
                  variant="secondary"
                  disabled={data.appInstalled === false}
                  onClick={() => setAttaching(true)}
                >
                  <Link2 /> Attach an existing one
                </Button>
              </div>
            }
          >
            The journal is the course documentation of this classroom: a private repository of{" "}
            <span className="font-mono">{data.orgLogin}</span> holding markdown, rendered here for
            your students. Write it in the browser, or clone it and push — both write the same
            files.
          </EmptyState>
          {data.appInstalled === false ? (
            <Alert tone="warning" icon={AlertTriangle} title="The GitHub App is not installed">
              Install it on {data.orgLogin} first: the journal is a repository of that organization.
            </Alert>
          ) : null}
        </Card>
        {creating ? (
          <CreateJournalModal
            base={base}
            proposedName={data.proposedName ?? "journal"}
            orgLogin={data.orgLogin}
            onClose={() => setCreating(false)}
            onDone={async () => {
              setCreating(false);
              await invalidate();
              toast("Journal created", "success");
            }}
          />
        ) : null}
        {attaching ? (
          <AttachJournalModal
            base={base}
            orgLogin={data.orgLogin}
            onClose={() => setAttaching(false)}
            onDone={async () => {
              setAttaching(false);
              await invalidate();
              toast("Journal attached", "success");
            }}
          />
        ) : null}
      </>
    );
  }

  const repo = data.journal;
  const pages = flatten(data.nav);
  const hidden = new Set(data.hiddenPaths ?? []);
  const menu: MenuItem[] = [
    {
      label: "Add a page",
      icon: FilePlus2,
      onSelect: () => setAdding(true),
    },
    {
      label: "Open on GitHub",
      icon: GithubIcon,
      href: repo.htmlUrl,
    },
    {
      label: "Copy the clone command",
      icon: Terminal,
      onSelect: () => {
        void navigator.clipboard.writeText(`git clone ${repo.cloneUrl}`);
        toast("Clone command copied", "success");
      },
    },
    {
      label: "Detach the journal",
      icon: Unlink,
      danger: true,
      onSelect: async () => {
        const ok = await confirm({
          title: "Detach the journal?",
          message:
            "The classroom stops showing it. The repository and its content are not touched, and you can attach it again at any time.",
          confirmLabel: "Detach",
          danger: true,
        });
        if (ok) detach.mutate();
      },
    },
  ];

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <SectionHeading
          icon={BookOpen}
          title="Journal"
          description={
            <span className="font-mono text-[13px]">
              {repo.fullName}
              {repo.ref === "main" ? "" : `#${repo.ref}`}
            </span>
          }
          className="border-b border-line px-4 py-3"
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                <RefreshCw /> Refresh
              </Button>
              <Menu label="Journal actions" items={menu} />
            </div>
          }
        />
        <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-[13px] sm:grid-cols-3">
          <div>
            <dt className="text-fg-faint">State</dt>
            <dd className="mt-0.5">
              {repo.syncStatus === "ok" ? (
                <span className="inline-flex items-center gap-1.5 text-fg">
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden /> In sync
                </span>
              ) : repo.syncStatus === "error" ? (
                <Badge tone="red">error</Badge>
              ) : (
                <Badge tone="zinc">pending</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-fg-faint">Last read from GitHub</dt>
            <dd className="mt-0.5 tabular-nums">
              {repo.lastSyncedAt ? formatDateTimeAs(repo.lastSyncedAt, "eu") : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-fg-faint">Pages</dt>
            <dd className="mt-0.5 tabular-nums">
              {pages.length}
              {data.hiddenCount ? (
                <span className="ml-2 text-fg-muted">{data.hiddenCount} hidden</span>
              ) : null}
            </dd>
          </div>
        </dl>
        {repo.syncStatus === "error" ? (
          <div className="px-4 pb-4">
            <Alert tone="danger" icon={AlertTriangle} title="The last read from GitHub failed">
              {repo.syncError}
            </Alert>
          </div>
        ) : null}
        {data.warningCount ? (
          <div className="px-4 pb-4">
            <Alert tone="warning" icon={AlertTriangle} title="Some pages have warnings">
              {data.warningCount === 1
                ? "One page renders with a warning"
                : `${data.warningCount} pages render with a warning`}{" "}
              — open it to see what it says.
            </Alert>
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeading
          icon={FileText}
          title="Pages"
          count={pages.length}
          className="border-b border-line px-4 py-3"
          actions={
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              <FilePlus2 /> Add a page
            </Button>
          }
        />
        {pages.length === 0 ? (
          <EmptyState icon={FileText} title="No page yet" className="py-10">
            Add one here, or push a markdown file to{" "}
            <span className="font-mono">{repo.fullName}</span>.
          </EmptyState>
        ) : (
          <ul>
            {data.homePath ? (
              <PageRow
                label="Front page"
                path={data.homePath}
                depth={0}
                hidden={hidden.has(data.homePath)}
                onOpen={() =>
                  navigate({ view: "journal", classroomId, pagePath: data.homePath! })
                }
              />
            ) : null}
            {pages.map(({ node, depth }) => (
              <PageRow
                key={node.path}
                label={node.title}
                path={node.pagePath ?? node.path}
                depth={depth}
                section={node.pagePath === null}
                hidden={node.pagePath !== null && hidden.has(node.pagePath)}
                onOpen={
                  node.pagePath
                    ? () => navigate({ view: "journal", classroomId, pagePath: node.pagePath! })
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </Card>

      {adding ? (
        <AddPageModal
          base={base}
          existing={pages.map((p) => p.node.pagePath ?? p.node.path)}
          onClose={() => setAdding(false)}
          onDone={async (path) => {
            setAdding(false);
            await invalidate();
            navigate({ view: "journal", classroomId, pagePath: path });
          }}
        />
      ) : null}
    </div>
  );
}

function PageRow({
  label,
  path,
  depth,
  hidden,
  section,
  onOpen,
}: {
  label: string;
  path: string;
  depth: number;
  hidden?: boolean;
  section?: boolean;
  onOpen?: () => void;
}) {
  const content = (
    <>
      <span
        className={cx("min-w-0 flex-1 truncate", section ? "font-semibold" : "font-medium")}
        style={{ paddingLeft: depth * 14 }}
      >
        {label}
      </span>
      {hidden ? (
        <Badge tone="amber">
          <EyeOff className="size-3" aria-hidden /> hidden
        </Badge>
      ) : null}
      <span className="hidden truncate font-mono text-xs text-fg-faint sm:block">{path}</span>
    </>
  );
  return (
    <li className="border-b border-line last:border-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] transition-colors hover:bg-surface-2"
        >
          {content}
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 px-4 py-2 text-[13px] text-fg-muted">
          {content}
        </div>
      )}
    </li>
  );
}

function CreateJournalModal({
  base,
  proposedName,
  orgLogin,
  onClose,
  onDone,
}: {
  base: string;
  proposedName: string;
  orgLogin: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(proposedName);
  const create = useMutation({
    mutationFn: () => api(base, { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: onDone,
  });
  const suggestion = (create.error as { body?: { suggestion?: string } } | null)?.body?.suggestion;
  return (
    <Modal
      title="Create the journal"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Field
            fullWidth
            label="Repository name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            Created private in <span className="font-mono">{orgLogin}</span>, with a README that
            explains the layout. The name records where the journal was created, not who reads it:
            one you will reuse next semester is better called something like{" "}
            <span className="font-mono">prog-c-journal</span>.
          </p>
        </div>
        {create.isError ? (
          <Alert tone="danger" icon={AlertTriangle} title="The journal was not created">
            {apiErrorMessage(create.error, "Try another name.")}
            {suggestion ? (
              <>
                {" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setName(suggestion)}
                >
                  Use {suggestion}
                </button>
              </>
            ) : null}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

function AttachJournalModal({
  base,
  orgLogin,
  onClose,
  onDone,
}: {
  base: string;
  orgLogin: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [root, setRoot] = useState("");
  const attach = useMutation({
    mutationFn: () =>
      api(`${base}/attach`, {
        method: "POST",
        body: JSON.stringify({
          fullName: name.includes("/") ? name.trim() : `${orgLogin}/${name.trim()}`,
          ...(ref.trim() ? { ref: ref.trim() } : {}),
          ...(root.trim() ? { rootPath: root.trim() } : {}),
        }),
      }),
    onSuccess: onDone,
  });
  return (
    <Modal
      title="Attach an existing journal"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={attach.isPending}
            disabled={name.trim() === ""}
            onClick={() => attach.mutate()}
          >
            Attach
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Field
            fullWidth
            label="Repository"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`${orgLogin}/prog-c-journal`}
            autoFocus
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            Must live in <span className="font-mono">{orgLogin}</span>. Attaching the same
            repository to several classrooms is how one course serves several sections: they read
            the same pages.
          </p>
        </div>
        <div>
          <Field
            fullWidth
            label="Branch"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="main"
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            Pin a branch to freeze what this classroom reads: last semester's cohort keeps its own
            while <span className="font-mono">main</span> moves on.
          </p>
        </div>
        <div>
          <Field
            fullWidth
            label="Sub-directory"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="(the repository root)"
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            Set it when the pages live under a folder, for instance{" "}
            <span className="font-mono">docs</span>.
          </p>
        </div>
        {attach.isError ? (
          <Alert tone="danger" icon={AlertTriangle} title="The journal was not attached">
            {apiErrorMessage(attach.error, "Check the name and try again.")}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

function AddPageModal({
  base,
  existing,
  onClose,
  onDone,
}: {
  base: string;
  existing: string[];
  onClose: () => void;
  onDone: (path: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  // The order lives in the file name, in steps of ten: propose the next one so
  // a teacher never has to think about it, and never has to renumber.
  const nextNumber = () => {
    const roots = existing.filter((p) => !p.includes("/"));
    const used = roots
      .map((p) => Number.parseInt(p, 10))
      .filter((n) => Number.isFinite(n));
    const next = (used.length ? Math.max(...used) : 0) + 10;
    return String(next).padStart(3, "0");
  };
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const proposed = path.trim() || (slug ? `${nextNumber()}-${slug}.md` : "");
  const create = useMutation({
    mutationFn: () =>
      api(`${base}/pages`, {
        method: "POST",
        body: JSON.stringify({ path: proposed, title: title.trim() || undefined }),
      }),
    onSuccess: () => onDone(proposed),
  });
  return (
    <Modal
      title="Add a page"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={proposed === ""}
            onClick={() => create.mutate()}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          fullWidth
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <div>
          <Field
            fullWidth
            label="File"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={proposed || "010-introduction.md"}
          />
          <p className="mt-1.5 text-xs text-fg-muted">
            The file name decides the order. Steps of ten leave room to insert a page later; put it
            in a folder to open a section.
          </p>
        </div>
        {create.isError ? (
          <Alert tone="danger" icon={AlertTriangle} title="The page was not created">
            {apiErrorMessage(create.error, "Pick another file name.")}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
