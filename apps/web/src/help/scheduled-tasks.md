# Scheduled tasks

## What they are

Background reconciliation with GitHub. Webhooks handle everything in real time; these tasks are the **safety net** that catches lost deliveries (missed pushes, missed workflow runs).

## How to operate them

Intervals are editable, tasks can be paused, and **Run now** triggers one immediately. A failed run is retried on the next pass — nothing is lost.
