import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { EMAIL_KINDS } from "@hgc/contracts";

import {
  queueEmail,
  resolvedPrefs,
  unsubSignature,
  verifyUnsubSignature,
} from "./mailer.js";

const config = {
  COOKIE_SECRET: "test-cookie-secret",
  PUBLIC_URL: "https://classroom.test",
} as AppConfig;

describe("resolvedPrefs", () => {
  it("fills every kind with its default when no prefs are stored", () => {
    const prefs = resolvedPrefs(null);
    for (const kind of Object.keys(EMAIL_KINDS)) {
      expect(prefs[kind as keyof typeof EMAIL_KINDS]).toBe(true);
    }
  });

  it("applies stored opt-outs and keeps defaults elsewhere", () => {
    const prefs = resolvedPrefs({ "grade.final": false });
    expect(prefs["grade.final"]).toBe(false);
    expect(prefs["repo.invitation"]).toBe(true);
  });

  it("ignores unknown keys (stale prefs survive catalogue changes)", () => {
    const prefs = resolvedPrefs({ "old.kind": false });
    expect("old.kind" in prefs).toBe(false);
  });
});

describe("unsubscribe signature (HMAC)", () => {
  it("verifies its own signature", () => {
    const sig = unsubSignature(config, "user-1", "grade.final");
    expect(verifyUnsubSignature(config, "user-1", "grade.final", sig)).toBe(true);
  });

  it("rejects a signature for another user or kind", () => {
    const sig = unsubSignature(config, "user-1", "grade.final");
    expect(verifyUnsubSignature(config, "user-2", "grade.final", sig)).toBe(false);
    expect(verifyUnsubSignature(config, "user-1", "repo.invitation", sig)).toBe(false);
  });

  it("rejects a truncated signature without throwing", () => {
    const sig = unsubSignature(config, "user-1", "grade.final");
    expect(verifyUnsubSignature(config, "user-1", "grade.final", sig.slice(0, 10))).toBe(false);
  });
});

describe("queueEmail preference gate", () => {
  const user = {
    id: "user-1",
    email: "student@heig-vd.ch",
    locale: "fr" as const,
    emailPrefs: null as Record<string, boolean> | null,
  };

  function appWith(boss: { send: ReturnType<typeof vi.fn> } | null) {
    return {
      boss,
      log: { error: vi.fn() },
    } as unknown as FastifyInstance;
  }

  it("enqueues a rendered email in the recipient's locale", async () => {
    const send = vi.fn();
    await queueEmail(appWith({ send }), config, user, "grade.final", {
      assignmentName: "Labo 2",
      grade: "5/6",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [, job] = send.mock.calls[0]!;
    expect(job.to).toBe("student@heig-vd.ch");
    expect(job.subject).toBe("Note disponible : Labo 2");
    expect(job.text).toContain("/app/email/unsub?u=user-1");
  });

  it("does nothing when the recipient opted out of the kind", async () => {
    const send = vi.fn();
    await queueEmail(
      appWith({ send }),
      config,
      { ...user, emailPrefs: { "grade.final": false } },
      "grade.final",
      {},
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does nothing when the queue is down (best effort)", async () => {
    await expect(queueEmail(appWith(null), config, user, "grade.final", {})).resolves.toBeUndefined();
  });

  it("swallows enqueue failures and logs them", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const app = appWith({ send });
    await expect(queueEmail(app, config, user, "grade.final", {})).resolves.toBeUndefined();
    expect((app.log.error as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
