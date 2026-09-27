import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ImagePlus, RotateCcw, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { JournalPage } from "@hgc/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { Alert, Button, Segmented, Spinner, cx } from "../ui";
import { JournalBody } from "./JournalBody";
import type { Route } from "../router";

/*
 * Editing one journal page in the browser — the path for a teacher who does not
 * want to know there is a git repository underneath (issue #45).
 *
 * The four decisions:
 * - Type: the source pane is 13 px mono (it is code), the preview is the
 *   student's own `.md-body`. Nothing else competes.
 * - Color: ONE accent, `Save`. The conflict alert is the only red, and it only
 *   exists when there is a conflict.
 * - Space: 12 inside the toolbar, 16 between the toolbar and the pane, 24 under
 *   the page header — the reading rhythm of the page it replaces.
 * - Finish: the pane is the same sheet of paper the reading view uses
 *   (`surface` + hairline + card radius). No shadow: it sits in the page flow.
 *
 * Two things here are not cosmetic:
 *
 * 1. **The preview is rendered by the SERVER**, by the very function the
 *    ingestion uses. A second, client-side markdown library would agree with it
 *    almost always — and disagree exactly where it matters: a link that does not
 *    resolve, an image outside the repository, a formula that does not compile.
 *    It also keeps the reading bundle free of any markdown parser.
 * 2. **A conflict is never resolved silently.** The blob sha the page was opened
 *    at travels with the save; GitHub refuses the write if someone pushed in the
 *    meantime, and the answer here is to say so and keep the draft, never to
 *    merge or to overwrite.
 */

/** Where an unsaved draft survives a reload, a crash or a refused save. */
const draftKey = (classroomId: string, path: string) => `hgc-journal-draft:${classroomId}:${path}`;

function readDraft(classroomId: string, path: string): string | null {
  try {
    return localStorage.getItem(draftKey(classroomId, path));
  } catch {
    return null;
  }
}

function writeDraft(classroomId: string, path: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(draftKey(classroomId, path));
    else localStorage.setItem(draftKey(classroomId, path), value);
  } catch {
    // A private window with storage blocked: the editor still works, the draft
    // just does not survive a reload. Never a reason to refuse the edit.
  }
}

/** The directory of a page, where its images are committed. */
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A file name that survives a URL and a git tree without surprises. */
function assetName(file: File): string {
  const fallback = `image-${Date.now()}.${(file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/g, "")}`;
  const raw = file.name || fallback;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

interface PreviewResult {
  html: string;
  warnings: string[];
}

export function JournalEditor({
  classroomId,
  page,
  navigate,
  onSaved,
  onCancel,
}: {
  classroomId: string;
  page: JournalPage;
  navigate: (r: Route) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const base = `/app/api/classrooms/${classroomId}/journal`;
  const [markdown, setMarkdown] = useState(page.markdown ?? "");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [conflict, setConflict] = useState(false);
  const [restorable, setRestorable] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = markdown !== (page.markdown ?? "");

  // A draft left behind by a reload or a refused save. Offered, never applied
  // on its own: silently replacing what is on GitHub with an old tab's text is
  // the one thing this editor must not do.
  useEffect(() => {
    const draft = readDraft(classroomId, page.path);
    if (draft !== null && draft !== (page.markdown ?? "")) setRestorable(draft);
  }, [classroomId, page.path, page.markdown]);

  useEffect(() => {
    if (dirty) writeDraft(classroomId, page.path, markdown);
  }, [classroomId, page.path, markdown, dirty]);

  const save = useMutation({
    mutationFn: () =>
      api<{ blobSha: string | null }>(`${base}/pages/${encodePath(page.path)}`, {
        method: "PUT",
        body: JSON.stringify({
          markdown,
          ...(page.blobSha ? { baseSha: page.blobSha } : {}),
        }),
      }),
    onSuccess: () => {
      writeDraft(classroomId, page.path, null);
      setConflict(false);
      onSaved();
    },
    onError: (err) => setConflict(err instanceof ApiError && err.status === 409),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const dir = dirOf(page.path);
      const name = assetName(file);
      const path = dir ? `${dir}/images/${name}` : `images/${name}`;
      await api(`${base}/assets/${encodePath(path)}`, {
        method: "POST",
        body: new Blob([await file.arrayBuffer()], { type: file.type }),
      });
      return `images/${name}`;
    },
    onSuccess: (relative) => insertAtCursor(area.current, `![](${relative})`, setMarkdown),
  });

  const runPreview = useCallback(async () => {
    const result = await api<PreviewResult>(`${base}/preview`, {
      method: "POST",
      body: JSON.stringify({ markdown, path: page.path }),
    });
    setPreview(result);
  }, [base, markdown, page.path]);

  // Debounced, and only while the preview is on screen: typing in the source
  // pane must not talk to the server on every keystroke.
  useEffect(() => {
    if (mode !== "preview") return;
    const timer = setTimeout(() => void runPreview().catch(() => setPreview(null)), 400);
    return () => clearTimeout(timer);
  }, [mode, runPreview]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (dirty) save.mutate();
    }
  };

  const takeFiles = (files: FileList | null) => {
    const file = Array.from(files ?? []).find((f) => f.type.startsWith("image/"));
    if (file) upload.mutate(file);
  };

  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          name="journal-editor-mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
        />
        <div className="flex items-center gap-2">
          <label
            className={cx(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg",
              upload.isPending && "pointer-events-none opacity-60",
            )}
          >
            <ImagePlus className="size-4" aria-hidden />
            {upload.isPending ? "Uploading…" : "Image"}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                takeFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X /> Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : <><Save /> Save</>}
          </Button>
        </div>
      </div>

      {conflict ? (
        <Alert
          tone="danger"
          icon={AlertTriangle}
          title="This page changed on GitHub since you opened it"
          action={
            <Button variant="secondary" size="sm" onClick={onSaved}>
              <RotateCcw /> Reload the page
            </Button>
          }
        >
          Nothing was overwritten and your text is kept in this browser. Reload to get the version
          that is on GitHub, then paste your changes back in.
        </Alert>
      ) : save.isError ? (
        <Alert tone="danger" icon={AlertTriangle} title="The page could not be saved">
          {apiErrorMessage(save.error, "Try again in a moment.")}
        </Alert>
      ) : null}

      {restorable !== null ? (
        <Alert
          tone="warning"
          icon={RotateCcw}
          title="An unsaved draft of this page is still in this browser"
          action={
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMarkdown(restorable);
                  setRestorable(null);
                }}
              >
                Restore it
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  writeDraft(classroomId, page.path, null);
                  setRestorable(null);
                }}
              >
                Discard
              </Button>
            </div>
          }
        >
          It was left by a reload or a save that did not go through.
        </Alert>
      ) : null}

      {upload.isError ? (
        <Alert tone="danger" icon={AlertTriangle} title="The image was not committed">
          {apiErrorMessage(upload.error, "Images must be under 5 MB.")}
        </Alert>
      ) : null}

      {mode === "write" ? (
        <div
          onDrop={(e) => {
            e.preventDefault();
            takeFiles(e.dataTransfer.files);
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <textarea
            ref={area}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            onPaste={(e) => {
              const file = Array.from(e.clipboardData.files).find((f) =>
                f.type.startsWith("image/"),
              );
              if (!file) return;
              e.preventDefault();
              upload.mutate(file);
            }}
            spellCheck={false}
            aria-label={`Markdown source of ${page.path}`}
            className="min-h-[60vh] w-full resize-y rounded-card border border-line bg-surface p-4 font-mono text-[13px] leading-relaxed text-fg"
          />
          <p className="mt-2 text-xs text-fg-faint">
            Drop or paste an image to commit it next to this page. Raw HTML is shown as text.
          </p>
        </div>
      ) : (
        <div className="rounded-card border border-line bg-surface p-6">
          {preview ? (
            <>
              {preview.warnings.length > 0 ? (
                <Alert tone="warning" icon={AlertTriangle} title="This page has warnings">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <JournalBody
                html={preview.html}
                navigate={navigate}
                className={preview.warnings.length > 0 ? "mt-4" : ""}
              />
            </>
          ) : (
            <Spinner label="Rendering" className="py-10" />
          )}
        </div>
      )}
    </div>
  );
}

/** Each segment encoded, the slashes kept: the route is a path, not a name. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Inserts text where the caret is, and leaves the caret after it. */
function insertAtCursor(
  area: HTMLTextAreaElement | null,
  text: string,
  setValue: (next: string) => void,
) {
  if (!area) return;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const before = area.value.slice(0, start);
  const after = area.value.slice(end);
  const glue = before === "" || before.endsWith("\n") ? "" : "\n\n";
  const next = `${before}${glue}${text}\n${after}`;
  setValue(next);
  requestAnimationFrame(() => {
    const caret = (before + glue + text).length + 1;
    area.focus();
    area.setSelectionRange(caret, caret);
  });
}
