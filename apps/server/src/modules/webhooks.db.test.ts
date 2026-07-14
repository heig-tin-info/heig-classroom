import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { AppConfig } from "../config.js";
import {
  assignments,
  classrooms,
  organizations,
  studentRepos,
  users,
} from "../db/schema.js";
import { testApp, type TestDb } from "../test/db.js";
import { handleOrganization } from "./webhooks.js";

const config = { PUBLIC_URL: "https://classroom.test", COOKIE_SECRET: "s" } as AppConfig;

/** One installed org with a classroom, an assignment and a provisioned repo. */
async function seed(db: TestDb) {
  const teacherId = randomUUID();
  const studentId = randomUUID();
  const orgId = randomUUID();
  const classroomId = randomUUID();
  const assignmentId = randomUUID();
  const repoId = randomUUID();
  await db.insert(users).values([
    { id: teacherId, oidcSub: `t-${teacherId}`, email: "t@heig.test", role: "teacher" },
    { id: studentId, oidcSub: `s-${studentId}`, email: "s@heig.test" },
  ]);
  await db.insert(organizations).values({
    id: orgId,
    login: "heig-prg1",
    githubOrgId: 4242,
    installationId: 99,
  });
  await db.insert(classrooms).values({ id: classroomId, orgId, teacherId, name: "PRG1" });
  await db.insert(assignments).values({
    id: assignmentId,
    classroomId,
    name: "Labo 1",
    slug: "labo-1",
    startAt: new Date("2026-07-01T08:00:00Z"),
    deadlineAt: new Date("2026-07-10T22:00:00Z"),
    sourceRepoId: 1,
    sourceFullName: "heig-prg1/labo-1",
    squashedFullName: "heig-prg1/labo-1-squashed",
    branches: ["main"],
    protectedFiles: [],
  });
  await db.insert(studentRepos).values({
    id: repoId,
    assignmentId,
    userId: studentId,
    fullName: "heig-prg1/labo-1-student",
    provisionStatus: "ok",
  });
  return { orgId, assignmentId, repoId };
}

describe("handleOrganization (webhook `organization`)", () => {
  it("renamed: updates the login and every stored full_name prefix", async () => {
    const app = await testApp();
    const { orgId, assignmentId, repoId } = await seed(app.db);

    await handleOrganization(app, config, {
      action: "renamed",
      organization: { id: 4242, login: "heig-prog-1" },
      changes: { login: { from: "heig-prg1" } },
    });

    const [org] = await app.db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.login).toBe("heig-prog-1");
    const [a] = await app.db.select().from(assignments).where(eq(assignments.id, assignmentId));
    expect(a!.sourceFullName).toBe("heig-prog-1/labo-1");
    expect(a!.squashedFullName).toBe("heig-prog-1/labo-1-squashed");
    const [r] = await app.db.select().from(studentRepos).where(eq(studentRepos.id, repoId));
    expect(r!.fullName).toBe("heig-prog-1/labo-1-student");
  });

  it("renamed: replayed delivery (login already current) is a no-op", async () => {
    const app = await testApp();
    const { assignmentId } = await seed(app.db);
    await handleOrganization(app, config, {
      action: "renamed",
      organization: { id: 4242, login: "heig-prg1" },
    });
    const [a] = await app.db.select().from(assignments).where(eq(assignments.id, assignmentId));
    expect(a!.sourceFullName).toBe("heig-prg1/labo-1");
  });

  it("deleted: degrades the organization and drops the installation", async () => {
    const app = await testApp();
    const { orgId } = await seed(app.db);
    await handleOrganization(app, config, {
      action: "deleted",
      organization: { id: 4242, login: "heig-prg1" },
    });
    const [org] = await app.db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org!.status).toBe("degraded");
    expect(org!.installationId).toBeNull();
  });

  it("ignores organizations unknown to the platform", async () => {
    const app = await testApp();
    await seed(app.db);
    await expect(
      handleOrganization(app, config, {
        action: "deleted",
        organization: { id: 999999, login: "someone-else" },
      }),
    ).resolves.toBeUndefined();
  });
});
