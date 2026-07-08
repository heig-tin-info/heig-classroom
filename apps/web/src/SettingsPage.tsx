import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, BellRing, GraduationCap, Languages, School, ShieldCheck, Unlink } from "lucide-react";

import { AdminPanel } from "./AdminPanel";
import { HelpIcon } from "./help";
import { useI18n, LOCALES } from "./i18n";
import { NOTICE_KINDS, notifyPrefs, setNotifyPref, type NoticeKind } from "./notify";
import { AvatarEditor } from "./AvatarEditor";
import { api, type Me } from "./api";
import { Badge, Button, Card, GithubIcon, isoDateTime } from "./ui";

function Avatar({ me, className = "size-16 text-xl" }: { me: Me; className?: string }) {
  if (me.avatarUrl) {
    return (
      <img
        src={me.avatarUrl}
        alt=""
        className={`rounded-full object-cover ${className}`}
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials =
    `${me.givenName.charAt(0)}${me.familyName.charAt(0)}`.toUpperCase() || "?";
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-accent font-semibold text-white ${className}`}
    >
      {initials}
    </span>
  );
}

/** Per-kind toggles for the real-time toasts; stored in this browser. */
function NotificationSettings() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState(notifyPrefs);
  const toggle = (kind: NoticeKind) => {
    const next = !prefs[kind];
    setNotifyPref(kind, next);
    setPrefs({ ...prefs, [kind]: next });
  };
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <BellRing className="size-4 text-zinc-400" />
        <h2 className="font-medium">{t("settings.notifications")}</h2>
        <HelpIcon topic="notifications" />
        <span className="text-xs text-zinc-400">{t("settings.notificationsHint")}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {NOTICE_KINDS.map(({ kind }) => (
          <label key={kind} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs[kind]}
              onChange={() => toggle(kind)}
              className="size-4 rounded border-zinc-300 accent-[var(--color-accent)]"
            />
            {t(`notify.${kind}` as Parameters<typeof t>[0])}
          </label>
        ))}
      </div>
    </Card>
  );
}

export function SettingsPage({ me, onBack }: { me: Me; onBack: () => void }) {
  const qc = useQueryClient();
  const { t, locale, setLocale } = useI18n();
  const [editingAvatar, setEditingAvatar] = useState(false);
  const unlink = useMutation({
    mutationFn: () => api("/app/auth/github/unlink", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const roleIcon =
    me.role === "admin" ? ShieldCheck : me.role === "teacher" ? School : GraduationCap;

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ArrowLeft className="size-4" /> {t("common.back")}
      </button>

      <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>

      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 font-medium">
          <Languages className="size-4 text-zinc-400" /> {t("settings.language")}
        </h2>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          {t("settings.languageHint")}
        </p>
        <div className="flex gap-2">
          {LOCALES.map((l) => (
            <button
              key={l.code}
              onClick={() => setLocale(l.code)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                locale === l.code
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </Card>

      <Card className="flex flex-wrap items-center gap-4 p-5">
        <button
          onClick={() => setEditingAvatar(true)}
          aria-label="Change profile picture"
          title="Change profile picture"
          className="group relative rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Avatar me={me} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            Edit
          </span>
        </button>
        <div className="min-w-0">
          <p className="text-lg font-medium">
            {me.givenName} {me.familyName}
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{me.email}</p>
          <p className="mt-1 flex items-center gap-2 text-sm">
            <Badge tone="zinc" icon={roleIcon}>
              {me.role}
            </Badge>
            {me.lastLoginAt ? (
              <span className="text-zinc-400">
                last sign-in {isoDateTime(me.lastLoginAt)}
              </span>
            ) : null}
          </p>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 font-medium">
          <GithubIcon className="size-4" /> {t("settings.github")}
        </h2>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          {t("settings.githubHint")}
        </p>
        {me.githubLogin ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="green" icon={GithubIcon}>
              {me.githubLogin}
            </Badge>
            <Button
              variant="subtle"
              onClick={() => {
                if (
                  window.confirm(
                    "Unlink your GitHub account? You will not be able to accept assignments until you link one again.",
                  )
                ) {
                  unlink.mutate();
                }
              }}
              disabled={unlink.isPending}
            >
              <Unlink className="size-4" /> {t("settings.unlink")}
            </Button>
          </div>
        ) : (
          <a
            href="/app/auth/github/link"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover"
          >
            <GithubIcon className="size-4" /> {t("settings.link")}
          </a>
        )}
      </Card>

      {editingAvatar ? (
        <AvatarEditor
          hasAvatar={me.hasUploadedAvatar}
          onClose={() => setEditingAvatar(false)}
        />
      ) : null}

      <NotificationSettings />

      {me.role === "admin" ? (
        <div className="border-t border-zinc-200/60 pt-6 dark:border-zinc-800/60">
          <AdminPanel />
        </div>
      ) : null}
    </div>
  );
}

export { Avatar };
