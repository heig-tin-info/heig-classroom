# ADR-010 — Secrets outside the repository and outside the database, in an encrypted institutional vault

## Status

Accepted (2026-07-03, phase 3).

## Context

Server secrets: the PEM private key of the GitHub App, the OIDC and GitHub OAuth client
secrets, the webhook secret, the cookie secret, the runner registration PAT (ADR-007). AU-43
requires that they come from the environment or from a secret manager, "never from the
repository nor from the database". The restore runbook (RTO 4 h, NFR-16) must be able to
reinject them reproducibly.

## Decision

1. **At runtime**: environment files on the VM (owned by root, permissions 600), the PEM key
   mounted read-only in the container; never in an image, a git repository or the database.
2. **For recovery**: an **age-encrypted** backup copy of each secret in the institutional
   vault (HEIG Vaultwarden or equivalent), referenced by the runbook; restoring is a script
   that decrypts and puts the files back.
3. **Rotation documented in the runbook**: the GitHub App accepts **two active private keys**
   during the switchover (generate, deploy, revoke the old one); the same interruption-free
   switchover procedure applies to the teacher API keys (AU-40) and to the runners PAT
   (12-month expiry).
4. **No secret in the logs**: dedicated pino serializers mask keys beyond their prefix, the
   OAuth `code`, cookies and `Authorization` headers (AU-41).

## Consequences

- A strict reading of AU-43 is satisfied: nothing in the repository, not even encrypted.
- Restoring depends on no human memory: the vault and the script make the RTO reproducible
  (the "manual KeePass" weakness is fixed).
- The compromise of a secret has a written response: immediate revocation on the GitHub or
  IdP side, rotation through the two-key procedure.

## Rejected alternatives

1. **sops/age secrets committed to the infrastructure repository** (productivity and
   robustness proposals): practical and versioned, but in literal tension with AU-43 ("never
   from the repository"); the encrypted copy therefore lives in a separate vault, not in git.
2. **A dedicated Vault (HashiCorp or equivalent)**: one more stateful service to operate and
   back up, out of proportion for about a dozen secrets.
3. **Secrets in the database**: forbidden by AU-43 and pointless — the database is backed up
   off site, which would widen the exposure surface.
