import { z } from "zod";

/** Rôles applicatifs (AU-07) : pas de rôle admin en v1 (H2). */
export const Role = z.enum(["student", "teacher"]);
export type Role = z.infer<typeof Role>;

export const Classroom = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  orgLogin: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type Classroom = z.infer<typeof Classroom>;

export const ClassroomCreate = z.object({
  name: z.string().min(1).max(200),
  orgLogin: z.string().min(1),
});
export type ClassroomCreate = z.infer<typeof ClassroomCreate>;

/** Statut d'une entrée de roster (AU-15, AU-18). */
export const EnrollmentStatus = z.enum(["pending", "claimed"]);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatus>;

export const Enrollment = z.object({
  id: z.uuid(),
  classroomId: z.uuid(),
  nom: z.string().min(1),
  prenom: z.string().min(1),
  email: z.email(),
  status: EnrollmentStatus,
  claimedAt: z.iso.datetime().nullable(),
  conflictFlag: z.boolean(),
});
export type Enrollment = z.infer<typeof Enrollment>;
