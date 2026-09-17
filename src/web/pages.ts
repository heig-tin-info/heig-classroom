/**
 * Les pages du portail, en HTML servi par Fastify. Pas de framework front en
 * v0 (analyse.md D8) : le parcours étudiant tient en un bouton et le tableau
 * enseignant en un `<table>`.
 *
 * La page de refus « session hors SEB » n'est pas ici : elle est fournie par
 * `seb/routes.ts` (`outsideSebPage`), pour que le message ne varie pas selon
 * la route qui refuse.
 */
import type { AssignmentRow, SessionRow } from "../db/schema.js";
import type { TeacherSessionRow } from "../sessions/store.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 62rem; padding: 0 1rem;
       line-height: 1.5; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
         border-bottom: 1px solid currentColor; padding-bottom: .5rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.4rem; margin: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid rgba(128,128,128,.4); }
button { font: inherit; padding: .35rem .9rem; cursor: pointer; }
.card { border: 1px solid rgba(128,128,128,.5); border-radius: .4rem; padding: 1rem;
        margin-bottom: 1rem; }
.mode { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
.muted { opacity: .7; font-size: .9rem; }
form { display: inline; }
`;

function layout(title: string, nav: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
<header><h1>${escapeHtml(title)}</h1><nav>${nav}</nav></header>
${body}
</body></html>
`;
}

function when(date: Date | null): string {
  if (!date) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function since(date: Date | null, now: Date): string {
  if (!date) return "—";
  const s = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
}

export interface HomeUser {
  login: string;
  displayName: string;
  role: "student" | "teacher";
}

export interface HomeAssignment {
  assignment: AssignmentRow;
  session: SessionRow | null;
}

/** `/` : les devoirs ouverts, avec leur bouton Démarrer. */
export function homePage(user: HomeUser, items: HomeAssignment[]): string {
  const nav =
    (user.role === "teacher" ? `<a href="/teacher/sessions">Sessions</a> · ` : "") +
    `${escapeHtml(user.displayName)} (${escapeHtml(user.role)}) · <a href="/auth/logout">Déconnexion</a>`;
  const cards =
    items.length === 0
      ? `<p class="muted">Aucun devoir ouvert pour le moment.</p>`
      : items
          .map(({ assignment, session }) => {
            const open = session
              ? `<a href="/s/${escapeHtml(session.id)}/">Rejoindre la session en cours</a>`
              : "";
            // Un devoir en mode examen ne se démarre pas d'ici : il se démarre
            // depuis Safe Exam Browser, par le lien `sebs://` (invariant 5).
            const action =
              assignment.mode === "exam"
                ? `<p class="muted">Épreuve : à ouvrir depuis Safe Exam Browser.
                   <a href="/exam/${escapeHtml(assignment.id)}.seb">Télécharger la configuration</a></p>`
                : `<form method="post" action="/assignments/${escapeHtml(assignment.id)}/start">
                     <button type="submit">Démarrer</button>
                   </form> ${open}`;
            return `<div class="card">
  <div class="mode">${escapeHtml(assignment.mode === "exam" ? "examen" : "travaux pratiques")}</div>
  <h2>${escapeHtml(assignment.title)}</h2>
  <p class="muted">${escapeHtml(assignment.id)} · image ${escapeHtml(assignment.image)}</p>
  ${action}
</div>`;
          })
          .join("\n");
  return layout("Environnements de développement", nav, cards);
}

/** `/teacher/sessions` : le tableau de surveillance. */
export function teacherSessionsPage(rows: TeacherSessionRow[], now: Date = new Date()): string {
  const body =
    rows.length === 0
      ? `<p class="muted">Aucune session.</p>`
      : `<table>
<thead><tr><th>Étudiant</th><th>Devoir</th><th>État</th><th>Dernier battement</th>
<th>Dernier push</th><th></th></tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr>
<td>${escapeHtml(r.displayName)}<br><span class="muted">${escapeHtml(r.session.student)}</span></td>
<td>${escapeHtml(r.assignmentTitle)}</td>
<td>${escapeHtml(r.session.state)}${r.session.sebVerified ? " · SEB" : ""}</td>
<td title="${escapeHtml(when(r.session.lastSeen))}">${escapeHtml(since(r.session.lastSeen, now))}</td>
<td title="${escapeHtml(when(r.lastPushAt))}">${escapeHtml(since(r.lastPushAt, now))}</td>
<td>${
      r.session.state === "closed" || r.session.state === "failed"
        ? ""
        : `<form method="post" action="/teacher/sessions/${escapeHtml(r.session.id)}/close">
             <button type="submit">Fermer</button></form>`
    }</td>
</tr>`,
  )
  .join("\n")}
</tbody></table>`;
  return layout(
    "Sessions actives",
    `<a href="/">Devoirs</a> · <a href="/auth/logout">Déconnexion</a>`,
    body,
  );
}

/** Page d'erreur générique du portail, en français et sans détail technique. */
export function errorPage(title: string, detail: string): string {
  return layout(title, `<a href="/">Retour</a>`, `<p>${escapeHtml(detail)}</p>`);
}
