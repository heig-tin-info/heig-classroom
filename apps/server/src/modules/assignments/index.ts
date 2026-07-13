/**
 * Assignments API, split by concern (same URLs as the original module):
 * - lifecycle.ts : list, create, patch (incl. deadline reopen), publish,
 *                  archive/unarchive, delete
 * - detail.ts    : detail table, grade-run history, repository activity
 * - actions.ts   : source pickers, sync, lock/unlock, grade-now
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { assignmentActionRoutes } from "./actions.js";
import { assignmentDetailRoutes } from "./detail.js";
import { assignmentLifecycleRoutes } from "./lifecycle.js";

export async function assignmentsPlugin(
  app: FastifyInstance,
  opts: { config: AppConfig },
) {
  await assignmentLifecycleRoutes(app, opts);
  await assignmentDetailRoutes(app, opts);
  await assignmentActionRoutes(app, opts);
}
