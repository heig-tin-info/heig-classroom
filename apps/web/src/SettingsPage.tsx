import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BellRing, GraduationCap, Mail, School, ShieldCheck, SlidersHorizontal, Unlink } from "lucide-react";

import { AvatarEditor } from "./AvatarEditor";
import { api, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { useI18n, LOCALES } from "./i18n";
import { DATE_FORMATS, EMAIL_KINDS, type DateFormat, type EmailKind, type Me, type NoticeKind } from "@hgc/contracts";

import { NOTICE_KINDS, notifyPrefs, setNotifyPref } from "./notify";
import { applyTheme, initialTheme, type ThemeChoice } from "./theme";
import {
  Avatar,
  Badge,
  Button,
  Card,
  formatDateTimeAs,
  GithubIcon,
  isoDateTime,
  LinkButton,
  PageHeader,
  SectionHeading,
  Segmented,
  Select,
  setDateFormat,
  SettingRow,
  Switch,
  Tip,
} from "./ui";

/** Language, appearance and date format: three rows, one card. */
function PreferencesCard({ me }: { me: Me }) {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);
  const saveDate = useMutation({
    mutationFn: (dateFormat: DateFormat) =>
      api("/app/api/me", { method: "PATCH", body: JSON.stringify({ dateFormat }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const current = me.dateFormat ?? "iso";
  const sample = new Date().toISOString();
  return (
    <section className="space-y-3">
      <SectionHeading icon={SlidersHorizontal} title={t("settings.preferences")} />
      <Card className="divide-y divide-line px-5">
        <SettingRow title={t("settings.language")} desc={t("settings.languageHint")}>
          <Segmented
            name="locale"
            value={locale}
            onChange={setLocale}
            options={LOCALES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </SettingRow>
        <SettingRow title={t("settings.appearance")} desc={t("settings.appearanceHint")}>
          <Segmented
            name="theme"
            value={theme}
            onChange={(v) => {
              setTheme(v);
              applyTheme(v);
            }}
            options={[
              { value: "light", label: t("settings.theme.light") },
              { value: "dark", label: t("settings.theme.dark") },
              { value: "system", label: t("settings.theme.system") },
            ]}
          />
        </SettingRow>
        <SettingRow title={t("settings.dateFormat")} desc={t("settings.dateFormatHint")}>
          <Select
            value={current}
            disabled={saveDate.isPending}
            onChange={(e) => {
              const f = e.target.value as DateFormat;
              setDateFormat(f);
              saveDate.mutate(f);
            }}
            className="w-52 tabular-nums"
            aria-label={t("settings.dateFormat")}
          >
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {formatDateTimeAs(sample, f)}
              </option>
            ))}
          </Select>
        </SettingRow>
      </Card>
      {saveDate.isError ? (
        <p className="text-[13px] text-danger">{apiErrorMessage(saveDate.error, t("error.save"))}</p>
      ) : null}
    </section>
  );
}

/** Per-kind toggles for the real-time toasts; stored in this browser. */
function NotificationsCard() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState(notifyPrefs);
  const toggle = (kind: NoticeKind, next: boolean) => {
    setNotifyPref(kind, next);
    setPrefs({ ...prefs, [kind]: next });
  };
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={BellRing}
        title={t("settings.notifications")}
        help="notifications"
        description={t("settings.notificationsBrowser")}
      />
      <Card className="divide-y divide-line px-5">
        {NOTICE_KINDS.map(({ kind }) => (
          <SettingRow key={kind} title={t(`notify.${kind}` as Parameters<typeof t>[0])} className="py-2.5">
            <Switch
              checked={prefs[kind]}
              onChange={(v) => toggle(kind, v)}
              label={t(`notify.${kind}` as Parameters<typeof t>[0])}
            />
          </SettingRow>
        ))}
      </Card>
    </section>
  );
}

/** Per-kind email opt-outs, persisted on the account (server-side). */
function EmailCard({ me }: { me: Me }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (prefs: Record<string, boolean>) =>
      api("/app/api/me", { method: "PATCH", body: JSON.stringify({ emailPrefs: prefs }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  // Teachers/admins can hold student seats (self-enroll), so they get every
  // toggle; students only see the kinds that can reach them.
  const teacher = me.role === "teacher" || me.role === "admin";
  const kinds = (Object.keys(EMAIL_KINDS) as EmailKind[]).filter(
    (kind) => teacher || EMAIL_KINDS[kind].audience === "student",
  );
  return (
    <section className="space-y-3">
      <SectionHeading icon={Mail} title={t("settings.emails")} description={t("settings.emailsHint")} />
      <Card className="divide-y divide-line px-5">
        {kinds.map((kind) => (
          <SettingRow key={kind} title={t(`email.${kind}` as Parameters<typeof t>[0])} className="py-2.5">
            <Switch
              checked={me.emailPrefs?.[kind] ?? true}
              onChange={(v) => save.mutate({ [kind]: v })}
              disabled={save.isPending}
              label={t(`email.${kind}` as Parameters<typeof t>[0])}
            />
          </SettingRow>
        ))}
      </Card>
      {save.isError ? (
        <p className="text-[13px] text-danger">{apiErrorMessage(save.error, t("error.save"))}</p>
      ) : null}
    </section>
  );
}

export function SettingsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useI18n();
  const [editingAvatar, setEditingAvatar] = useState(false);
  const unlink = useMutation({
    mutationFn: () => api("/app/auth/github/unlink", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const roleIcon =
    me.role === "admin" ? ShieldCheck : me.role === "teacher" ? School : GraduationCap;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader title={t("settings.title")} />

      <section className="space-y-3">
        <SectionHeading title={t("settings.profile")} />
        <Card className="divide-y divide-line">
          <div className="flex flex-wrap items-center gap-5 p-5">
            <Tip label={t("settings.changePicture")}>
              <button
                type="button"
                onClick={() => setEditingAvatar(true)}
                aria-label={t("settings.changePicture")}
                className="group relative rounded-full"
              >
                <Avatar me={me} className="size-16 text-xl" />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-fg/50 text-xs font-medium text-canvas opacity-0 transition-opacity group-hover:opacity-100">
                  {t("settings.changePicture")}
                </span>
              </button>
            </Tip>
            <div className="min-w-0 flex-1">
              <p className="text-[17px] font-bold tracking-tight">
                {me.givenName} {me.familyName}
              </p>
              <p className="text-sm text-fg-muted">{me.email}</p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-fg-faint">
                <Badge tone="zinc" icon={roleIcon}>
                  {t(`settings.role.${me.role}` as Parameters<typeof t>[0])}
                </Badge>
                {me.lastLoginAt ? <span>{t("settings.lastSignIn", { date: isoDateTime(me.lastLoginAt) })}</span> : null}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 p-5">
            {/* A wide minimum: below it the buttons drop to their own line
                rather than squeezing the sentence. */}
            <div className="min-w-56 flex-1">
              <p className="flex items-center gap-2 font-semibold">
                <GithubIcon className="size-4 text-fg-faint" /> {t("settings.github")}
              </p>
              <p className="mt-0.5 text-[13px] text-fg-muted">{t("settings.githubHint")}</p>
            </div>
            {me.githubLogin ? (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="green" icon={GithubIcon}>
                  {me.githubLogin}
                </Badge>
                <Button
                  variant="secondary"
                  loading={unlink.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: t("settings.unlink"),
                        message: t("settings.unlinkConfirm"),
                        confirmLabel: t("settings.unlink"),
                        cancelLabel: t("common.cancel"),
                        danger: true,
                      })
                    ) {
                      unlink.mutate();
                    }
                  }}
                >
                  <Unlink /> {t("settings.unlink")}
                </Button>
              </div>
            ) : (
              <LinkButton href="/app/auth/github/link" variant="primary">
                <GithubIcon /> {t("settings.link")}
              </LinkButton>
            )}
            {unlink.isError ? (
              <p className="w-full text-[13px] text-danger">
                {apiErrorMessage(unlink.error, t("error.save"))}
              </p>
            ) : null}
          </div>
        </Card>
      </section>

      <PreferencesCard me={me} />
      <NotificationsCard />
      <EmailCard me={me} />

      {editingAvatar ? (
        <AvatarEditor
          hasAvatar={me.hasUploadedAvatar}
          onClose={() => setEditingAvatar(false)}
        />
      ) : null}
    </div>
  );
}
