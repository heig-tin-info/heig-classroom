import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api } from "./api";

/**
 * Lightweight i18n: a flat key -> string dictionary per locale, a `t(key,
 * vars)` helper with `{var}` interpolation, and a provider that persists the
 * chosen language to the user's account (so it follows them across devices)
 * with a localStorage mirror for an instant, flash-free first paint. English
 * is the fallback for any missing key or unset locale.
 *
 * Scope (decided 2026-07-13): student-facing surfaces (StudentHome, settings,
 * emails, toasts) go through `t()` and are maintained in en+fr; teacher-only
 * surfaces (classroom management, assignment forms, roster, admin) stay in
 * plain English — teachers work in English here and duplicating those strings
 * is not worth the upkeep. Don't add `t()` to teacher-only components.
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
  "menu.user": "User menu",
  "menu.studentView": "Switch to student view",
  "menu.teacherView": "Back to teacher view",
  "menu.lightTheme": "Light theme",
  "menu.darkTheme": "Dark theme",
  "menu.studentViewBanner": "You are viewing the portal as a student.",
  "common.cancel": "Cancel",
  "classrooms.summary": "{n} classrooms · {students} students",
  "classrooms.coTaught": "co-taught",
  "classrooms.noUpcoming": "No upcoming deadline",
  "classrooms.newHint": "Bind a GitHub organization to a student roster.",

  "classroom.gradeSheet": "Grade sheet",
  "classroom.gradeSheetTip":
    "Download the grades of the whole classroom as an Excel sheet (students × assignments)",
  "classroom.gradeSheetStarted": "Preparing the grade sheet…",
  "classroom.gradeSheetReady": "Grade sheet downloaded",

  "roster.join": "Join as student",
  "roster.joined": "You have a seat in this classroom",

  "staff.title": "Staff",
  "staff.empty": "No one else works on this classroom",
  "staff.readonly": "Only the owner of the classroom can change the staff.",
  "staff.pending": "has not signed in yet",
  "staff.email": "E-mail",
  "staff.add": "Add",
  "staff.remove": "Remove from the staff",
  "staff.confirmRemove": "Remove {email} from the staff of this classroom?",
  "staff.role.teacher": "Teacher",
  "staff.role.assistant": "Assistant",

  "github.linked": "GitHub account linked.",
  "github.conflict": "This GitHub account is already linked to another user.",
  "github.failed": "GitHub linking failed, try again.",

  "nav.classrooms": "Classrooms",
  "nav.assignment": "Assignment",
  "common.search": "Search…",
  "common.refresh": "Refresh",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "error.server": "The server did not answer. Try again in a moment.",
  "error.save": "Could not save this change.",
  "view.cards": "Card view",
  "view.list": "List view",
  "view.timeline": "Timeline view",

  "classrooms.title": "My classrooms",
  "classrooms.empty.title": "No classrooms",
  "classrooms.empty.body": "Create your first classroom to distribute assignments to your students.",
  "classrooms.archives": "Archives",
  "classrooms.archived": "archived",
  "classrooms.restore": "Restore",
  "classrooms.archivedOn": "archived on {date}",
  "classrooms.archives.empty": "No archived classrooms",
  "classrooms.archives.emptyBody": "Classrooms you archive end up here and can be restored.",
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
  "classrooms.newAction": "Create classroom",
  "classrooms.name": "Name",
  "classrooms.org": "GitHub organization",
  "classrooms.orgPick": "Pick an organization (App installed)",
  "classrooms.orgOther": "Other organization…",
  "classrooms.noOrgHint": "No organization yet?",
  "classrooms.noOrgLink": "Create one on GitHub",
  "classrooms.noOrgHint2": "(free plan works), then enter its name here — a wizard on the classroom page walks you through installing the App.",
  "classrooms.create": "Create",
  "classrooms.createFailed": "Creation failed.",

  "student.title": "My classrooms",
  "student.linkPrompt": "Link your GitHub account (top right) to be able to accept assignments.",
  "student.empty.title": "No classrooms yet",
  "student.empty.body":
    "Your teacher enrolls you through the class roster — classrooms appear here automatically once you are on it.",
  "student.loadFailed": "Could not load your classrooms",
  "student.noMatch": "No assignment matches",
  "student.noMatchBody": "Search by assignment name or by classroom name.",
  "student.noAssignments": "No published assignments yet.",
  "student.openRepo": "Open your repository",
  "student.acceptInvite": "Accept the GitHub invitation first (check your notifications).",
  "student.groupWith": "{group} · with {names}",
  "student.provisionInProgress": "Your repository is being created right now — try again in a moment.",
  "student.githubStale":
    "Cannot reach your GitHub account. Did you rename or change it? Reconnect your GitHub account, then try again.",
  "student.githubRelink": "Reconnect GitHub account",
  "student.groupTip": "Group work: one repository, shared by the whole group",
  "student.accept": "Accept assignment",
  "student.retry": "Retry acceptance",
  "student.creating": "Creating your repository…",
  "student.ciRunning": "CI running",
  "student.ciPass": "CI pass",
  "student.ciFail": "CI fail",
  "student.grade": "grade {points}/{max}",
  "student.gradeFinal": "final grade {points}/{max}",
  "student.indicative": "indicative, not contractual",
  "student.reviewed": "final review",
  "student.final": "final grade",
  "student.finalTip": "Grade validated by the teacher",
  "student.reviewedTip": "Graded by the full LLM review of your frozen submission",
  "student.reviewIn": "full review in {t}",
  "student.reviewRunning": "full review running…",
  "student.reviewPendingTip":
    "The deadline has passed; the full review of your frozen submission replaces this grade once it lands",
  "student.commits": "{n} commits",
  "student.commits.one": "{n} commit",
  "student.testsPassing": "{passed}/{total} passing",
  "student.noTests": "No tests reported yet.",
  "student.locked": "locked",
  "student.workspace": "Online workspace",
  "student.workspaceSeb": "Exam workspace",
  "student.start": "Start",
  "student.openSeb": "Open in Safe Exam Browser",
  "student.sebOnly":
    "This assignment runs in an exam session: it only opens from Safe Exam Browser, never from an ordinary browser.",
  "student.deadlineCol": "Deadline",
  "student.upNext": "Up next",
  "student.summary": "{n} open assignments",
  "student.summary.one": "{n} open assignment",
  "student.linkAction": "Link GitHub account",
  "student.teacher": "taught by {name}",
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

  "assignment.searchStudents": "Search students…",
  "assignment.col.student": "Student",
  "assignment.col.group": "Group",
  "assignment.col.status": "Status",
  "assignment.col.lastCommit": "Last commit",
  "assignment.col.commits": "Commits",
  "assignment.col.checks": "Checks",
  "assignment.col.grade": "Grade",
  "assignment.gradeNow": "Grade now (run the grading CI on the last commit)",
  "assignment.gradesValidated": "grades validated",
  "assignment.validate": "Validate grades",
  "assignment.revalidate": "Re-validate grades",
  "assignment.validateConfirm":
    "Validate the grades? Students will see their final grade (teacher adjustments included).",
  "assignment.export": "Export",
  "assignment.exportTip": "Download the grades as an Excel sheet",
  "assignment.cloneScript": "Clone script",
  "assignment.cloneScriptTip":
    "Download a bash script that clones (or pulls) every student repository, and pushes them back with the `push` argument",
  "assignment.gradeNowStarted": "Grading started — the grade will appear when the run completes",
  "assignment.gradeNowUnsupported": "This repository's grading workflow does not support manual runs",
  "assignment.lockRepo": "Lock repository (block pushes)",
  "assignment.unlockRepo": "Unlock repository (allow pushes again)",
  "assignment.activity.empty": "No commits yet.",
  "assignment.activity.perDay": "commits per day",
  "assignment.activity.perWeek": "commits per week",
  "assignment.activity.commitsOverTime": "Commits over time",
  "assignment.activity.testsOverTime": "Tests over time",
  "assignment.activity.noTests": "No graded runs with test counters yet.",
  "assignment.activity.passed": "passed",
  "assignment.activity.total": "total",

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
  "settings.appearance": "Appearance",
  "settings.appearanceHint": "Light or dark, or follow the system.",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.system": "System",
  "settings.profile": "Profile",
  "settings.preferences": "Preferences",
  "settings.lastSignIn": "Last sign-in {date}",
  "settings.changePicture": "Change picture",
  "settings.unlinkConfirm":
    "Unlink your GitHub account? You will not be able to accept assignments until you link one again.",
  "settings.role.admin": "Administrator",
  "settings.role.teacher": "Teacher",
  "settings.role.student": "Student",
  "settings.notificationsBrowser": "Shown in this browser while the portal is open.",
  "settings.dateFormat": "Date format",
  "settings.dateFormatHint": "How dates and times are displayed across the portal.",
  "settings.github": "GitHub account",
  "settings.githubHint": "Your GitHub account is used to deliver assignment repositories to you.",
  "settings.unlink": "Unlink GitHub account",
  "settings.link": "Link GitHub account",
  "settings.notifications": "Notifications",

  "palette.title": "Command palette",
  "palette.open": "Search",
  "palette.placeholder": "Search classrooms, actions and help…",
  "palette.noResult": "No result for “{query}”",
  "palette.result": "{n} result",
  "palette.results": "{n} results",
  "palette.group.navigate": "Navigation",
  "palette.group.classroom": "Classroom",
  "palette.group.action": "Actions",
  "palette.group.help": "Help",
  "palette.openClassroom": "Open classroom {name}",
  "palette.tab.assignments": "Open the assignments",
  "palette.tab.students": "Open the students",
  "palette.tab.staff": "Open the staff",
  "palette.tab.settings": "Open the classroom settings",
  "palette.themeSystem": "Follow the system theme",
  "palette.switchLocale": "Switch to {language}",
  "palette.external": "External link",
  "palette.helpHint": "Help",
  "palette.hint.move": "to move",
  "palette.hint.run": "to run",
  "palette.hint.close": "to close",

  "help.title": "Help",
  "notify.student_joined": "Student joined a classroom",
  "notify.assignment_accepted": "Assignment accepted",
  "notify.commit_pushed": "Commit pushed",
  "notify.grade_captured": "Grade captured",
  "notify.protected_reverted": "Protected files restored",
  "notify.deadline_applied": "Deadline enforced",
  "notify.llm_review_dispatched": "LLM review dispatched",
  "notify.sync": "Sync activity",

  "settings.emails": "Email notifications",
  "settings.emailsHint": "Sent to your account address; saved on your account.",
  "email.assignment.published": "New assignment published",
  "email.deadline.reminder": "Deadline reminder (24 h before)",
  "email.grade.final": "Final grade available",
  "email.repo.invitation": "Repository created",
  "email.provision.error": "Repository provisioning failed",
  "email.deadline.applied": "Deadline enforced (summary)",
  "email.org.deleted": "GitHub organization deleted",
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
  "menu.user": "Menu utilisateur",
  "menu.studentView": "Passer en vue étudiant",
  "menu.teacherView": "Revenir à la vue enseignant",
  "menu.lightTheme": "Thème clair",
  "menu.darkTheme": "Thème sombre",
  "menu.studentViewBanner": "Vous consultez le portail en tant qu'étudiant.",
  "common.cancel": "Annuler",
  "classrooms.summary": "{n} classes · {students} étudiants",
  "classrooms.coTaught": "co-enseignée",
  "classrooms.noUpcoming": "Aucune échéance à venir",
  "classrooms.newHint": "Associez une organisation GitHub à une liste d'étudiants.",

  "classroom.gradeSheet": "Feuille de notes",
  "classroom.gradeSheetTip":
    "Télécharger les notes de toute la classe en fichier Excel (étudiants × travaux)",
  "classroom.gradeSheetStarted": "Préparation de la feuille de notes…",
  "classroom.gradeSheetReady": "Feuille de notes téléchargée",

  "roster.join": "Me joindre comme étudiant",
  "roster.joined": "Vous avez une place dans cette classe",

  "staff.title": "Équipe",
  "staff.empty": "Personne d'autre ne travaille sur cette classe",
  "staff.readonly": "Seul le propriétaire de la classe peut modifier l'équipe.",
  "staff.pending": "ne s'est pas encore connecté",
  "staff.email": "Courriel",
  "staff.add": "Ajouter",
  "staff.remove": "Retirer de l'équipe",
  "staff.confirmRemove": "Retirer {email} de l'équipe de cette classe ?",
  "staff.role.teacher": "Enseignant",
  "staff.role.assistant": "Assistant",

  "github.linked": "Compte GitHub lié.",
  "github.conflict": "Ce compte GitHub est déjà lié à un autre utilisateur.",
  "github.failed": "La liaison GitHub a échoué, réessayez.",

  "nav.classrooms": "Classes",
  "nav.assignment": "Devoir",
  "common.search": "Rechercher…",
  "common.refresh": "Actualiser",
  "common.loading": "Chargement…",
  "common.retry": "Réessayer",
  "error.server": "Le serveur n'a pas répondu. Réessayez dans un instant.",
  "error.save": "Impossible d'enregistrer ce changement.",
  "view.cards": "Vue cartes",
  "view.list": "Vue liste",
  "view.timeline": "Vue chronologie",

  "classrooms.title": "Mes classes",
  "classrooms.empty.title": "Aucune classe",
  "classrooms.empty.body": "Créez votre première classe pour distribuer des devoirs à vos étudiants.",
  "classrooms.archives": "Archives",
  "classrooms.archived": "archivée",
  "classrooms.restore": "Restaurer",
  "classrooms.archivedOn": "archivée le {date}",
  "classrooms.archives.empty": "Aucune classe archivée",
  "classrooms.archives.emptyBody": "Les classes archivées arrivent ici et peuvent être restaurées.",
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
  "classrooms.newAction": "Créer une classe",
  "classrooms.name": "Nom",
  "classrooms.org": "Organisation GitHub",
  "classrooms.orgPick": "Choisir une organisation (App installée)",
  "classrooms.orgOther": "Autre organisation…",
  "classrooms.noOrgHint": "Pas encore d'organisation ?",
  "classrooms.noOrgLink": "Créez-la sur GitHub",
  "classrooms.noOrgHint2": "(le plan gratuit suffit), puis saisissez son nom ici — un assistant sur la page de la classe vous guide pour installer l'App.",
  "classrooms.create": "Créer",
  "classrooms.createFailed": "La création a échoué.",

  "student.title": "Mes classes",
  "student.linkPrompt": "Liez votre compte GitHub (en haut à droite) pour pouvoir accepter des devoirs.",
  "student.empty.title": "Aucune classe pour l'instant",
  "student.empty.body":
    "Votre enseignant vous inscrit via la liste de classe — les classes apparaissent ici automatiquement une fois que vous y figurez.",
  "student.loadFailed": "Impossible de charger vos classes",
  "student.noMatch": "Aucun devoir ne correspond",
  "student.noMatchBody": "Cherchez par nom de devoir ou par nom de classe.",
  "student.noAssignments": "Aucun devoir publié pour l'instant.",
  "student.openRepo": "Ouvrir votre dépôt",
  "student.acceptInvite": "Acceptez d'abord l'invitation GitHub (vérifiez vos notifications).",
  "student.groupWith": "{group} · avec {names}",
  "student.provisionInProgress": "Votre dépôt est en cours de création — réessayez dans un instant.",
  "student.githubStale":
    "Impossible de joindre votre compte GitHub. L'avez-vous renommé ou changé ? Reconnectez votre compte GitHub, puis réessayez.",
  "student.githubRelink": "Reconnecter le compte GitHub",
  "student.groupTip": "Travail de groupe : un seul dépôt, partagé par tout le groupe",
  "student.accept": "Accepter le devoir",
  "student.retry": "Réessayer l'acceptation",
  "student.creating": "Création de votre dépôt…",
  "student.ciRunning": "CI en cours",
  "student.ciPass": "CI réussie",
  "student.ciFail": "CI échouée",
  "student.grade": "note {points}/{max}",
  "student.gradeFinal": "note finale {points}/{max}",
  "student.indicative": "indicative, non contractuelle",
  "student.reviewed": "correction finale",
  "student.final": "note finale",
  "student.finalTip": "Note validée par l'enseignant",
  "student.reviewedTip": "Note issue de la correction LLM complète de votre rendu gelé",
  "student.reviewIn": "correction complète dans {t}",
  "student.reviewRunning": "correction complète en cours…",
  "student.reviewPendingTip":
    "L'échéance est passée ; la correction complète de votre rendu gelé remplacera cette note dès qu'elle arrive",
  "student.commits": "{n} commits",
  "student.commits.one": "{n} commit",
  "student.testsPassing": "{passed}/{total} réussis",
  "student.noTests": "Aucun test rapporté pour l'instant.",
  "student.locked": "verrouillé",
  "student.workspace": "Environnement en ligne",
  "student.workspaceSeb": "Environnement d'examen",
  "student.start": "Démarrer",
  "student.openSeb": "Ouvrir dans Safe Exam Browser",
  "student.sebOnly":
    "Ce devoir se déroule en session d'examen : elle ne s'ouvre que depuis Safe Exam Browser, jamais depuis un navigateur ordinaire.",
  "student.deadlineCol": "Échéance",
  "student.upNext": "À venir",
  "student.summary": "{n} devoirs ouverts",
  "student.summary.one": "{n} devoir ouvert",
  "student.linkAction": "Lier un compte GitHub",
  "student.teacher": "enseigné par {name}",
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

  "assignment.searchStudents": "Rechercher des étudiants…",
  "assignment.col.student": "Étudiant",
  "assignment.col.group": "Groupe",
  "assignment.col.status": "Statut",
  "assignment.col.lastCommit": "Dernier commit",
  "assignment.col.commits": "Commits",
  "assignment.col.checks": "Vérifs",
  "assignment.col.grade": "Note",
  "assignment.gradeNow": "Noter maintenant (lance le CI de correction sur le dernier commit)",
  "assignment.gradesValidated": "notes validées",
  "assignment.validate": "Valider les notes",
  "assignment.revalidate": "Revalider les notes",
  "assignment.validateConfirm":
    "Valider les notes ? Les étudiants verront leur note finale (ajustements compris).",
  "assignment.export": "Exporter",
  "assignment.exportTip": "Télécharger les notes en fichier Excel",
  "assignment.cloneScript": "Script de clonage",
  "assignment.cloneScriptTip":
    "Télécharger un script bash qui clone (ou met à jour) tous les dépôts des étudiants, et les pousse avec l’argument « push »",
  "assignment.gradeNowStarted": "Correction lancée — la note apparaîtra à la fin du run",
  "assignment.gradeNowUnsupported": "Le workflow de correction de ce dépôt ne permet pas le lancement manuel",
  "assignment.lockRepo": "Verrouiller le dépôt (bloque les pushs)",
  "assignment.unlockRepo": "Déverrouiller le dépôt (autorise à nouveau les pushs)",
  "assignment.activity.empty": "Aucun commit pour l’instant.",
  "assignment.activity.perDay": "commits par jour",
  "assignment.activity.perWeek": "commits par semaine",
  "assignment.activity.commitsOverTime": "Commits dans le temps",
  "assignment.activity.testsOverTime": "Évolution des tests",
  "assignment.activity.noTests": "Aucun run corrigé avec compteurs de tests pour l’instant.",
  "assignment.activity.passed": "réussis",
  "assignment.activity.total": "total",

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
  "settings.appearance": "Apparence",
  "settings.appearanceHint": "Clair ou sombre, ou suivre le système.",
  "settings.theme.light": "Clair",
  "settings.theme.dark": "Sombre",
  "settings.theme.system": "Système",
  "settings.profile": "Profil",
  "settings.preferences": "Préférences",
  "settings.lastSignIn": "Dernière connexion {date}",
  "settings.changePicture": "Changer la photo",
  "settings.unlinkConfirm":
    "Délier votre compte GitHub ? Vous ne pourrez plus accepter de devoirs tant que vous n'en liez pas un autre.",
  "settings.role.admin": "Administrateur",
  "settings.role.teacher": "Enseignant",
  "settings.role.student": "Étudiant",
  "settings.notificationsBrowser": "Affichées dans ce navigateur tant que le portail est ouvert.",
  "settings.dateFormat": "Format de date",
  "settings.dateFormatHint": "Affichage des dates et heures dans tout le portail.",
  "settings.github": "Compte GitHub",
  "settings.githubHint": "Votre compte GitHub sert à vous distribuer les dépôts de devoir.",
  "settings.unlink": "Délier le compte GitHub",
  "settings.link": "Lier un compte GitHub",
  "settings.notifications": "Notifications",

  "palette.title": "Palette de commandes",
  "palette.open": "Rechercher",
  "palette.placeholder": "Rechercher une classe, une action, de l'aide…",
  "palette.noResult": "Aucun résultat pour « {query} »",
  "palette.result": "{n} résultat",
  "palette.results": "{n} résultats",
  "palette.group.navigate": "Navigation",
  "palette.group.classroom": "Classe",
  "palette.group.action": "Actions",
  "palette.group.help": "Aide",
  "palette.openClassroom": "Ouvrir la classe {name}",
  "palette.tab.assignments": "Ouvrir les devoirs",
  "palette.tab.students": "Ouvrir la liste des étudiants",
  "palette.tab.staff": "Ouvrir l'équipe enseignante",
  "palette.tab.settings": "Ouvrir les réglages de la classe",
  "palette.themeSystem": "Suivre le thème du système",
  "palette.switchLocale": "Passer en {language}",
  "palette.external": "Lien externe",
  "palette.helpHint": "Aide",
  "palette.hint.move": "pour naviguer",
  "palette.hint.run": "pour exécuter",
  "palette.hint.close": "pour fermer",

  "help.title": "Aide",
  "notify.student_joined": "Étudiant rejoint une classe",
  "notify.assignment_accepted": "Devoir accepté",
  "notify.commit_pushed": "Commit poussé",
  "notify.grade_captured": "Note capturée",
  "notify.protected_reverted": "Fichiers protégés restaurés",
  "notify.deadline_applied": "Échéance appliquée",
  "notify.llm_review_dispatched": "Review LLM déclenchée",
  "notify.sync": "Activité de synchronisation",

  "settings.emails": "Notifications par e-mail",
  "settings.emailsHint": "Envoyées à l'adresse du compte ; enregistrées sur le compte.",
  "email.assignment.published": "Nouveau devoir publié",
  "email.deadline.reminder": "Rappel d'échéance (24 h avant)",
  "email.grade.final": "Note finale disponible",
  "email.repo.invitation": "Dépôt créé",
  "email.provision.error": "Échec de création d'un dépôt",
  "email.deadline.applied": "Échéance appliquée (résumé)",
  "email.org.deleted": "Organisation GitHub supprimée",
};

/** Both dictionaries, exported so a test can assert that a key exists in both. */
export const DICTS: Record<Locale, Record<string, string>> = { en, fr };

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
