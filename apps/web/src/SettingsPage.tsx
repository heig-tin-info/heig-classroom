import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, GraduationCap, School, ShieldCheck, Unlink } from "lucide-react";

import { AdminPanel } from "./AdminPanel";
import { api, type Me } from "./api";
import { Badge, Button, Card, GithubIcon, isoDateTime } from "./ui";

function Avatar({ me, className = "size-16 text-xl" }: { me: Me; className?: string }) {
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

export function SettingsPage({ me, onBack }: { me: Me; onBack: () => void }) {
  const qc = useQueryClient();
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
        <ArrowLeft className="size-4" /> Back
      </button>

      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card className="flex flex-wrap items-center gap-4 p-5">
        <Avatar me={me} />
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
          <GithubIcon className="size-4" /> GitHub account
        </h2>
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
          Your GitHub account is used to deliver assignment repositories to you.
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
              <Unlink className="size-4" /> Unlink GitHub account
            </Button>
          </div>
        ) : (
          <a
            href="/app/auth/github/link"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:-translate-y-px hover:bg-accent-hover"
          >
            <GithubIcon className="size-4" /> Link GitHub account
          </a>
        )}
      </Card>

      {me.role === "admin" ? (
        <div className="border-t border-zinc-200/60 pt-6 dark:border-zinc-800/60">
          <AdminPanel />
        </div>
      ) : null}
    </div>
  );
}

export { Avatar };
