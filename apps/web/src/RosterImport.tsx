import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, UserPlus } from "lucide-react";
import { useRef, useState } from "react";

import { api, ApiError } from "./api";
import { Button, cx, Field, Sheet, Textarea } from "./ui";

type Cell = string | number | null;

/** Dropped file to tabular rows. Excel/ODS via SheetJS, otherwise text CSV. */
async function fileToPayload(
  file: File,
): Promise<{ csv: string } | { rows: Cell[][] }> {
  if (/\.(xlsx|xls|ods)$/i.test(file.name)) {
    // SheetJS weighs ~430 kB minified: load it only when a spreadsheet is
    // actually dropped, never in the initial bundle.
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]!];
    if (!sheet) throw new Error("Empty workbook");
    const rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, {
      header: 1,
      defval: null,
      raw: false, // formatted e-mails stay as text
    });
    return { rows };
  }
  return { csv: await file.text() };
}

/** "Add students" sheet: a file drop, one student by hand, or pasted CSV. */
export function RosterImport({ classroomId, onClose }: { classroomId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [manual, setManual] = useState({ nom: "", prenom: "", email: "" });
  const fileInput = useRef<HTMLInputElement>(null);

  const importRoster = useMutation({
    mutationFn: async (payload: { csv: string } | { rows: Cell[][] }) =>
      "csv" in payload
        ? api(`/app/api/classrooms/${classroomId}/roster`, {
            method: "POST",
            csv: payload.csv,
          })
        : api(`/app/api/classrooms/${classroomId}/roster`, {
            method: "POST",
            body: JSON.stringify(payload),
          }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["classroom", classroomId] }),
  });

  async function handleFile(file: File) {
    setFileName(file.name);
    try {
      importRoster.mutate(await fileToPayload(file));
    } catch {
      setFileName(`${file.name} — unreadable file`);
    }
  }

  const importErrors =
    importRoster.isError && importRoster.error instanceof ApiError
      ? ((importRoster.error.body as { errors?: { line: number; message: string }[] })
          ?.errors ?? [])
      : [];

  const eyebrow = "text-[11px] font-semibold uppercase tracking-wider text-fg-faint";

  return (
    <Sheet
      title="Add students"
      subtitle="Last name, first name and e-mail — the student claims the seat on first sign-in"
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1">
            {importRoster.isSuccess ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-success">
                <CheckCircle2 className="size-4" /> Import done
              </span>
            ) : importRoster.isError && importErrors.length === 0 ? (
              <span className="text-sm text-danger">Import failed.</span>
            ) : null}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-7">
        <section className="space-y-3">
          <p className={eyebrow}>From a file</p>
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop a roster file"
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
            className={cx(
              "flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed px-4 py-8 text-center transition-colors",
              dragging ? "border-accent bg-accent-soft" : "border-line-strong hover:border-fg-faint hover:bg-surface-2/60",
            )}
          >
            <FileSpreadsheet className="size-7 text-fg-faint" />
            <p className="text-sm font-semibold">Drop an Excel or CSV file here, or click to browse</p>
            <p className="max-w-sm text-xs text-fg-muted">
              .xlsx, .xls, .ods, .csv — the last name, first name and e-mail columns are detected
              automatically (French headers work too); other columns are ignored.
            </p>
            {fileName ? <p className="text-xs text-fg-muted">{fileName}</p> : null}
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.ods,.csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
        </section>

        <section className="space-y-3">
          <p className={eyebrow}>One student</p>
          <form
            className="grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              importRoster.mutate({
                rows: [
                  ["lastname", "firstname", "email"],
                  [manual.nom, manual.prenom, manual.email],
                ],
              });
              setManual({ nom: "", prenom: "", email: "" });
            }}
          >
            <Field
              label="Last name"
              required
              fullWidth
              value={manual.nom}
              onChange={(e) => setManual({ ...manual, nom: e.target.value })}
            />
            <Field
              label="First name"
              required
              fullWidth
              value={manual.prenom}
              onChange={(e) => setManual({ ...manual, prenom: e.target.value })}
            />
            <div className="col-span-2 flex items-end gap-3">
              <Field
                label="E-mail"
                required
                type="email"
                fullWidth
                placeholder="prenom.nom@heig-vd.ch"
                value={manual.email}
                onChange={(e) => setManual({ ...manual, email: e.target.value })}
              />
              <Button type="submit" variant="secondary" loading={importRoster.isPending}>
                <UserPlus /> Add
              </Button>
            </div>
          </form>
        </section>

        <section className="space-y-3">
          <p className={eyebrow}>Pasted CSV</p>
          <Textarea
            aria-label="Roster CSV"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"lastname,firstname,email\nDupont,Marie,marie.dupont@heig-vd.ch"}
            className="font-mono text-xs"
          />
          <Button
            variant="secondary"
            onClick={() => importRoster.mutate({ csv })}
            disabled={csv.trim().length === 0}
            loading={importRoster.isPending}
          >
            <Upload /> Import CSV
          </Button>
        </section>

        {importErrors.length > 0 ? (
          <ul className="space-y-1 text-sm text-danger">
            {importErrors.map((e, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <AlertTriangle className="size-3.5" /> line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}
