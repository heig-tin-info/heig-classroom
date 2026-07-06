# Spike S2 — Provisionnement via GitHub App

> Exécuté le 2026-07-06 sur l'organisation sandbox `heig-test-classroom`
> (plan Team, GitHub App `hgc-dev` installée sur tous les dépôts).
> Script : `apps/server/spikes/s2-provisioning.ts`
> (`pnpm --filter @hgc/server exec tsx spikes/s2-provisioning.ts`).

## Résultats contre les critères de sortie (docs/03, section Spikes)

| Critère | Résultat |
| --- | --- |
| 30 provisionnements consécutifs sans 403 secondary rate limit | ✅ 30/30, aucun 403 |
| Chaque provisionnement < 60 s | ✅ moyenne 4,1 s, p50 4,1 s, max 4,4 s |
| Chaîne complète création → push → ruleset | ✅ dépôt privé, push git réel `x-access-token`, ruleset actif |
| Push d'un dépôt contenant `.github/workflows/grading.yml` | ✅ la permission **Workflows RW** suffit |
| Ruleset anti force-push / anti suppression posé par l'App | ✅ `non_fast_forward` + `deletion` sur la branche par défaut |
| Ruleset **lock** posé puis retiré par l'App (mécanique deadline GH-41) | ✅ push refusé pendant le lock, retrait OK |
| Idempotence : rejeu sans doublon | ✅ rejeu en 1,4 s, aucune recréation, aucune erreur |
| Budget quota API | ✅ ~15 requêtes/dépôt cycle complet ; 448 restants consommés sur 5 500 pour 2×30 dépôts + cleanup |
| Suppression des dépôts par l'App (cleanup) | ✅ Administration RW suffit |

## Enseignements pour M2

1. **Piège retry Octokit** : `GET /git/matching-refs` sur un dépôt vide répond
   `409 Git Repository is empty`, et le plugin retry d'Octokit transforme ce 409
   en ~40 s de backoff (3 tentatives). Règle pour le module de provisionnement :
   ne jamais interroger les refs d'un dépôt qu'on vient de créer, et passer
   `request: { retries: 0 }` sur les appels dont les 4xx sont porteurs de sens.
2. Le push immédiat après création ne pose aucun problème (~1 s) : pas de délai
   d'initialisation côté GitHub à cette échelle.
3. Timing type d'un provisionnement : création ~2,4 s, push ~1,1 s,
   ruleset ~0,7 s. Extrapolation 100 dépôts séquentiels ≈ 7 min ; avec la
   concurrence bornée à 10 prévue par l'architecture, largement sous les
   contraintes (le budget deadline NFR-13 n'utilise de toute façon que des
   appels ruleset, ~0,7 s).
4. `POST /orgs/{org}/repos` est annoncé déprécié (retrait mars 2028) — prévoir
   la migration vers son remplaçant avant cette échéance (noté pour M2).

## Restes à faire (hors de portée sans second compte)

- **Force push refusé côté étudiant réel** et bypass org admin (GH-41) : à
  rejouer avec `S2_STUDENT_LOGIN=<login>` dès qu'un compte étudiant de test est
  disponible ; le script gère déjà l'invitation.
- **Quota d'invitations org / 24 h (C-07.3)** : non mesuré — le sonder
  consommerait le quota réel et enverrait de vraies invitations. Décision :
  conserver le rate limiter d'invitations à débit configurable prévu par
  l'architecture, et mesurer passivement lors du premier usage réel (M2
  journalise chaque invitation et toute erreur de quota).
