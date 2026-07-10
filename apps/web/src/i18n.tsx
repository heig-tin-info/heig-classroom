import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api } from "./api";

/**
 * Lightweight i18n: a flat key -> string dictionary per locale, a `t(key,
 * vars)` helper with `{var}` interpolation, and a provider that persists the
 * chosen language to the user's account (so it follows them across devices)
 * with a localStorage mirror for an instant, flash-free first paint. English
 * is the fallback for any missing key or unset locale.
 */
export type Locale = "en" | "fr";

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

const STORE_KEY = "hgc-locale";

const en = {
  "app.title": "HEIG Classroom",
  "landing.tagline":
    "Practical work on GitHub: individual repositories, automatic deadlines and an indicative grade after every CI run.",
  "landing.signin": "Sign in with Switch edu-ID",
  "landing.footer": "HEIG-VD — TIN Department",

  "header.sources": "Project sources on GitHub",
  "header.docs": "Documentation",
  "menu.settings": "Settings",
  "menu.signout": "Sign out",
  "menu.toggleTheme": "Toggle theme",
  "menu.user": "User menu",

  "github.linked": "GitHub account linked.",
  "github.conflict": "This GitHub account is already linked to another user.",
  "github.failed": "GitHub linking failed, try again.",

  "nav.classrooms": "Classrooms",
  "nav.assignment": "Assignment",
  "common.search": "Search…",
  "common.back": "Back",
  "common.refresh": "Refresh",
  "view.cards": "Card view",
  "view.list": "List view",
  "view.timeline": "Timeline view",

  "classrooms.title": "My classrooms",
  "classrooms.empty.title": "No classrooms",
  "classrooms.empty.body": "Create your first classroom to distribute assignments to your students.",
  "classrooms.students": "{n} students",
  "classrooms.students.one": "{n} student",
  "classrooms.claimed": "{n} claimed",
  "classrooms.assignments": "{n} assignments",
  "classrooms.assignments.one": "{n} assignment",
  "classrooms.col.name": "Name",
  "classrooms.col.org": "Organization",
  "classrooms.col.students": "Students",
  "classrooms.col.claimed": "Claimed",
  "classrooms.col.assignments": "Assignments",
  "classrooms.col.created": "Created",
  "classrooms.roster": "Roster",
  "classrooms.andMore": "… and {n} more",
  "classrooms.new": "New classroom",
  "classrooms.name": "Name",
  "classrooms.org": "GitHub organization",
  "classrooms.orgPick": "Pick an organization (App installed)",
  "classrooms.orgOther": "Other organization…",
  "classrooms.create": "Create",
  "classrooms.createFailed": "Creation failed.",

  "student.title": "My classrooms",
  "student.linkPrompt": "Link your GitHub account (top right) to be able to accept assignments.",
  "student.empty.title": "No classrooms yet",
  "student.empty.body":
    "Your teacher enrolls you through the class roster — classrooms appear here automatically once you are on it.",
  "student.noAssignments": "No published assignments yet.",
  "student.openRepo": "Open your repository",
  "student.acceptInvite": "Accept the GitHub invitation first (check your notifications).",
  "student.accept": "Accept assignment",
  "student.retry": "Retry acceptance",
  "student.creating": "Creating your repository…",
  "student.ciRunning": "CI running",
  "student.ciPass": "CI pass",
  "student.ciFail": "CI fail",
  "student.grade": "grade {points}/{max}",
  "student.gradeFinal": "final grade {points}/{max}",
  "student.indicative": "indicative, not contractual",
  "student.commits": "{n} commits",
  "student.commits.one": "{n} commit",
  "student.tests": "Tests",
  "student.testsPassing": "{passed}/{total} passing",
  "student.noTests": "No tests reported yet.",
  "student.locked": "locked",
  "student.deadlineCol": "Deadline",
  "student.due": "due {date}",
  "student.until": "in {duration}",
  "student.overdue": "closed {duration} ago",
  "dur.day": "{n} day",
  "dur.days": "{n} days",
  "dur.hour": "{n} hour",
  "dur.hours": "{n} hours",
  "dur.minute": "{n} minute",
  "dur.minutes": "{n} minutes",
  "dur.soon": "less than a minute",
  "dur.and": "and",

  "assignment.accepted": "{n}/{total} accepted",
  "assignment.searchStudents": "Search students…",
  "assignment.col.student": "Student",
  "assignment.col.repo": "Repo",
  "assignment.col.status": "Status",
  "assignment.col.lastCommit": "Last commit",
  "assignment.col.date": "Date",
  "assignment.col.commits": "Commits",
  "assignment.col.checks": "Checks",
  "assignment.col.grade": "Grade",
  "assignment.gradeNow": "Grade now (run the grading CI on the last commit)",
  "assignment.gradeNowStarted": "Grading started — the grade will appear when the run completes",
  "assignment.gradeNowUnsupported": "This repository's grading workflow does not support manual runs",
  "assignment.lockRepo": "Lock repository (block pushes)",
  "assignment.unlockRepo": "Unlock repository (allow pushes again)",
  "assignment.activity.empty": "No commits yet.",
  "assignment.activity.perDay": "commits per day",
  "assignment.activity.perWeek": "commits per week",
  "status.accepted": "accepted",
  "status.locked": "locked",
  "status.notAccepted": "not accepted",
  "status.notClaimed": "not claimed",
  "status.provisionError": "provision error",
  "status.repoMissing": "repo missing",
  "state.draft": "draft",
  "state.published": "published",
  "state.locked": "locked",

  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.languageHint": "Interface language.",
  "settings.github": "GitHub account",
  "settings.githubHint": "Your GitHub account is used to deliver assignment repositories to you.",
  "settings.unlink": "Unlink GitHub account",
  "settings.link": "Link GitHub account",
  "settings.notifications": "Notifications",
  "settings.notificationsHint": "Real-time toasts, bottom left.",

  "help.title": "Help",
  "notify.student_joined": "Student joined a classroom",
  "notify.assignment_accepted": "Assignment accepted",
  "notify.commit_pushed": "Commit pushed",
  "notify.grade_captured": "Grade captured",
  "notify.protected_reverted": "Protected files restored",
  "notify.deadline_applied": "Deadline enforced",
  "notify.sync": "Sync activity",
};

export type Dict = typeof en;

const fr: Record<keyof Dict, string> = {
  "app.title": "HEIG Classroom",
  "landing.tagline":
    "Travaux pratiques sur GitHub : dépôts individuels, échéances automatiques et une note indicative après chaque exécution CI.",
  "landing.signin": "Se connecter avec Switch edu-ID",
  "landing.footer": "HEIG-VD — Département TIN",

  "header.sources": "Sources du projet sur GitHub",
  "header.docs": "Documentation",
  "menu.settings": "Réglages",
  "menu.signout": "Se déconnecter",
  "menu.toggleTheme": "Changer de thème",
  "menu.user": "Menu utilisateur",

  "github.linked": "Compte GitHub lié.",
  "github.conflict": "Ce compte GitHub est déjà lié à un autre utilisateur.",
  "github.failed": "La liaison GitHub a échoué, réessayez.",

  "nav.classrooms": "Classes",
  "nav.assignment": "Devoir",
  "common.search": "Rechercher…",
  "common.back": "Retour",
  "common.refresh": "Actualiser",
  "view.cards": "Vue cartes",
  "view.list": "Vue liste",
  "view.timeline": "Vue chronologie",

  "classrooms.title": "Mes classes",
  "classrooms.empty.title": "Aucune classe",
  "classrooms.empty.body": "Créez votre première classe pour distribuer des devoirs à vos étudiants.",
  "classrooms.students": "{n} étudiants",
  "classrooms.students.one": "{n} étudiant",
  "classrooms.claimed": "{n} rattachés",
  "classrooms.assignments": "{n} devoirs",
  "classrooms.assignments.one": "{n} devoir",
  "classrooms.col.name": "Nom",
  "classrooms.col.org": "Organisation",
  "classrooms.col.students": "Étudiants",
  "classrooms.col.claimed": "Rattachés",
  "classrooms.col.assignments": "Devoirs",
  "classrooms.col.created": "Créée",
  "classrooms.roster": "Liste",
  "classrooms.andMore": "… et {n} de plus",
  "classrooms.new": "Nouvelle classe",
  "classrooms.name": "Nom",
  "classrooms.org": "Organisation GitHub",
  "classrooms.orgPick": "Choisir une organisation (App installée)",
  "classrooms.orgOther": "Autre organisation…",
  "classrooms.create": "Créer",
  "classrooms.createFailed": "La création a échoué.",

  "student.title": "Mes classes",
  "student.linkPrompt": "Liez votre compte GitHub (en haut à droite) pour pouvoir accepter des devoirs.",
  "student.empty.title": "Aucune classe pour l'instant",
  "student.empty.body":
    "Votre enseignant vous inscrit via la liste de classe — les classes apparaissent ici automatiquement une fois que vous y figurez.",
  "student.noAssignments": "Aucun devoir publié pour l'instant.",
  "student.openRepo": "Ouvrir votre dépôt",
  "student.acceptInvite": "Acceptez d'abord l'invitation GitHub (vérifiez vos notifications).",
  "student.accept": "Accepter le devoir",
  "student.retry": "Réessayer l'acceptation",
  "student.creating": "Création de votre dépôt…",
  "student.ciRunning": "CI en cours",
  "student.ciPass": "CI réussie",
  "student.ciFail": "CI échouée",
  "student.grade": "note {points}/{max}",
  "student.gradeFinal": "note finale {points}/{max}",
  "student.indicative": "indicative, non contractuelle",
  "student.commits": "{n} commits",
  "student.commits.one": "{n} commit",
  "student.tests": "Tests",
  "student.testsPassing": "{passed}/{total} réussis",
  "student.noTests": "Aucun test rapporté pour l'instant.",
  "student.locked": "verrouillé",
  "student.deadlineCol": "Échéance",
  "student.due": "échéance {date}",
  "student.until": "dans {duration}",
  "student.overdue": "clôturé il y a {duration}",
  "dur.day": "{n} jour",
  "dur.days": "{n} jours",
  "dur.hour": "{n} heure",
  "dur.hours": "{n} heures",
  "dur.minute": "{n} minute",
  "dur.minutes": "{n} minutes",
  "dur.soon": "moins d'une minute",
  "dur.and": "et",

  "assignment.accepted": "{n}/{total} acceptés",
  "assignment.searchStudents": "Rechercher des étudiants…",
  "assignment.col.student": "Étudiant",
  "assignment.col.repo": "Dépôt",
  "assignment.col.status": "Statut",
  "assignment.col.lastCommit": "Dernier commit",
  "assignment.col.date": "Date",
  "assignment.col.commits": "Commits",
  "assignment.col.checks": "Vérifs",
  "assignment.col.grade": "Note",
  "assignment.gradeNow": "Noter maintenant (lance le CI de correction sur le dernier commit)",
  "assignment.gradeNowStarted": "Correction lancée — la note apparaîtra à la fin du run",
  "assignment.gradeNowUnsupported": "Le workflow de correction de ce dépôt ne permet pas le lancement manuel",
  "assignment.lockRepo": "Verrouiller le dépôt (bloque les pushs)",
  "assignment.unlockRepo": "Déverrouiller le dépôt (autorise à nouveau les pushs)",
  "assignment.activity.empty": "Aucun commit pour l’instant.",
  "assignment.activity.perDay": "commits par jour",
  "assignment.activity.perWeek": "commits par semaine",
  "status.accepted": "accepté",
  "status.locked": "verrouillé",
  "status.notAccepted": "non accepté",
  "status.notClaimed": "non rattaché",
  "status.provisionError": "erreur de création",
  "status.repoMissing": "dépôt manquant",
  "state.draft": "brouillon",
  "state.published": "publié",
  "state.locked": "verrouillé",

  "settings.title": "Réglages",
  "settings.language": "Langue",
  "settings.languageHint": "Langue de l'interface.",
  "settings.github": "Compte GitHub",
  "settings.githubHint": "Votre compte GitHub sert à vous distribuer les dépôts de devoir.",
  "settings.unlink": "Délier le compte GitHub",
  "settings.link": "Lier un compte GitHub",
  "settings.notifications": "Notifications",
  "settings.notificationsHint": "Notifications en temps réel, en bas à gauche.",

  "help.title": "Aide",
  "notify.student_joined": "Étudiant rejoint une classe",
  "notify.assignment_accepted": "Devoir accepté",
  "notify.commit_pushed": "Commit poussé",
  "notify.grade_captured": "Note capturée",
  "notify.protected_reverted": "Fichiers protégés restaurés",
  "notify.deadline_applied": "Échéance appliquée",
  "notify.sync": "Activité de synchronisation",
};

const DICTS: Record<Locale, Record<string, string>> = { en, fr };

export type TFunction = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale]?.[key] ?? DICTS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale, persist?: boolean) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  setLocale: () => {},
  t: (k) => translate("en", k),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = localStorage.getItem(STORE_KEY);
    return stored === "fr" || stored === "en" ? stored : "en";
  });
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale, persist = true) => {
    setLocaleState(l);
    localStorage.setItem(STORE_KEY, l);
    if (persist) {
      void api("/app/api/me", { method: "PATCH", body: JSON.stringify({ locale: l }) }).catch(
        () => {},
      );
    }
  }, []);
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

/** "4 days, 2 hours and 23 minutes" — localized, largest three units. */
export function formatDuration(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(t(days === 1 ? "dur.day" : "dur.days", { n: days }));
  if (hours > 0) parts.push(t(hours === 1 ? "dur.hour" : "dur.hours", { n: hours }));
  if (minutes > 0 || parts.length === 0) {
    if (minutes === 0 && parts.length === 0) return t("dur.soon");
    parts.push(t(minutes === 1 ? "dur.minute" : "dur.minutes", { n: minutes }));
  }
  if (parts.length === 1) return parts[0]!;
  const last = parts.pop()!;
  return `${parts.join(", ")} ${t("dur.and")} ${last}`;
}
