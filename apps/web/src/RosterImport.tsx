import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, UserPlus } from "lucide-react";
import { useRef, useState } from "react";

import { HelpIcon } from "./help";
import { api, ApiError } from "./api";
import { Button, Card } from "./ui";

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

export function RosterImport({ classroomId }: { classroomId: string }) {
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

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Upload className="size-4 text-zinc-400" />
        <h2 className="font-medium">Import roster</h2>
        <HelpIcon topic="import-roster" />
      </div>

      {/* File drop: Excel, LibreOffice or CSV */}
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
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging
            ? "border-accent bg-accent/5"
            : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-500"
        }`}
      >
        <FileSpreadsheet className="size-8 text-zinc-400" />
        <p className="text-sm font-medium">
          Drop an Excel or CSV file here, or click to browse
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          .xlsx, .xls, .ods, .csv — last name, first name and e-mail columns are
          detected automatically (French headers work too); other columns are ignored
        </p>
        {fileName ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{fileName}</p>
        ) : null}
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

      {/* Manually add a student */}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
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
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Last name</span>
          <input
            required
            value={manual.nom}
            onChange={(e) => setManual({ ...manual, nom: e.target.value })}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">First name</span>
          <input
            required
            value={manual.prenom}
            onChange={(e) => setManual({ ...manual, prenom: e.target.value })}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">E-mail</span>
          <input
            required
            type="email"
            value={manual.email}
            onChange={(e) => setManual({ ...manual, email: e.target.value })}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <Button disabled={importRoster.isPending}>
          <UserPlus className="size-4" /> Add student
        </Button>
      </form>

      {/* Or pasted CSV */}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
          … or paste CSV (last name, first name, e-mail)
        </summary>
        <textarea
          aria-label="Roster CSV"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"lastname,firstname,email\nDupont,Marie,marie.dupont@heig-vd.ch"}
          className="mt-2 min-h-28 w-full rounded-lg border border-zinc-300 bg-white p-3 font-mono text-sm shadow-sm placeholder:text-zinc-400 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <Button
          className="mt-2"
          onClick={() => importRoster.mutate({ csv })}
          disabled={importRoster.isPending || csv.trim().length === 0}
        >
          <Upload className="size-4" /> Import CSV
        </Button>
      </details>

      {importRoster.isSuccess ? (
        <p className="mt-3 inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-4" /> Import done
        </p>
      ) : null}
      {importErrors.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm text-red-600 dark:text-red-400">
          {importErrors.map((e, i) => (
            <li key={i} className="flex items-center gap-1">
              <AlertTriangle className="size-3.5" /> line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      ) : importRoster.isError && importErrors.length === 0 ? (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">Import failed.</p>
      ) : null}
    </Card>
  );
}
