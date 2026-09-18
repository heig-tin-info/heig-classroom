# Spike S2 — Provisioning via the GitHub App

> Run on 2026-07-06 on the sandbox organization `heig-test-classroom`
> (Team plan, GitHub App `hgc-dev` installed on all repositories).
> The spike script was removed after this report was written; the findings
> below are the record that remains of it.

## Results against the exit criteria (docs/03, Spikes section)

| Criterion | Result |
| --- | --- |
| 30 consecutive provisionings without a 403 secondary rate limit | ✅ 30/30, no 403 |
| Each provisioning < 60 s | ✅ average 4.1 s, p50 4.1 s, max 4.4 s |
| Full chain creation → push → ruleset | ✅ private repository, real git push with `x-access-token`, active ruleset |
| Push of a repository containing `.github/workflows/grading.yml` | ✅ the **Workflows RW** permission is enough |
| Anti force-push / anti deletion ruleset set by the App | ✅ `non_fast_forward` + `deletion` on the default branch |
| **Lock** ruleset set and then removed by the App (GH-41 deadline mechanism) | ✅ push refused during the lock, removal OK |
| Idempotence: replay without duplicates | ✅ replay in 1.4 s, no re-creation, no error |
| API quota budget | ✅ ~15 requests per repository for a full cycle; 448 of the 5,500 remaining consumed for 2×30 repositories + cleanup |
| Deletion of the repositories by the App (cleanup) | ✅ Administration RW is enough |

## Lessons for M2

1. **Octokit retry trap**: `GET /git/matching-refs` on an empty repository answers
   `409 Git Repository is empty`, and Octokit's retry plugin turns that 409
   into ~40 s of backoff (3 attempts). Rule for the provisioning module:
   never query the refs of a repository that has just been created, and pass
   `request: { retries: 0 }` on the calls whose 4xx responses are meaningful.
2. Pushing immediately after creation causes no problem at all (~1 s): there is no
   initialization delay on the GitHub side at this scale.
3. Typical timing of a provisioning: creation ~2.4 s, push ~1.1 s,
   ruleset ~0.7 s. Extrapolation for 100 sequential repositories ≈ 7 min; with the
   concurrency bounded to 10 planned by the architecture, well below the
   constraints (the NFR-13 deadline budget only uses ruleset
   calls anyway, ~0.7 s).
4. `POST /orgs/{org}/repos` is announced as deprecated (removal in March 2028) — plan
   the migration to its replacement before that date (noted for M2).

## Remaining work (out of reach without a second account)

- **Force push refused on a real student account** and org admin bypass (GH-41): to be
  replayed with `S2_STUDENT_LOGIN=<login>` as soon as a test student account is
  available; the procedure already covers the invitation.
- **Org invitation quota / 24 h (C-07.3)**: not measured — probing it
  would consume the real quota and send real invitations. Decision:
  keep the invitation rate limiter with a configurable throughput planned by the
  architecture, and measure passively on the first real use (M2
  logs every invitation and any quota error).
