# Étude préliminaire S2 — Provisionnement via la GitHub App

> Menée le 2026-07-06 sur l'organisation bac à sable `heig-test-classroom`
> (plan Team, GitHub App `hgc-dev` installée sur tous les dépôts).
> Le script de l'étude a été supprimé après la rédaction de ce rapport ;
> les constats ci-dessous en sont la trace qui subsiste.

## Résultats face aux critères de sortie (docs/03, section Études préliminaires)

| Critère | Résultat |
| --- | --- |
| 30 provisionnements consécutifs sans limite de débit secondaire 403 | ✅ 30/30, aucun 403 |
| Chaque provisionnement < 60 s | ✅ moyenne 4,1 s, p50 4,1 s, max 4,4 s |
| Chaîne complète création → push → ruleset | ✅ dépôt privé, vrai push git avec `x-access-token`, ruleset actif |
| Push d'un dépôt contenant `.github/workflows/grading.yml` | ✅ la permission **Workflows RW** suffit |
| Ruleset anti force-push / anti suppression posé par l'App | ✅ `non_fast_forward` + `deletion` sur la branche par défaut |
| Ruleset **lock** posé puis retiré par l'App (mécanisme de délai de rendu GH-41) | ✅ push refusé pendant le verrouillage, retrait OK |
| Idempotence : rejeu sans doublons | ✅ rejeu en 1,4 s, aucune re-création, aucune erreur |
| Budget de quota API | ✅ ~15 requêtes par dépôt pour un cycle complet ; 448 des 5 500 restantes consommées pour 2×30 dépôts + nettoyage |
| Suppression des dépôts par l'App (nettoyage) | ✅ Administration RW suffit |

## Enseignements pour M2

1. **Piège des nouvelles tentatives d'Octokit** : `GET /git/matching-refs` sur un dépôt vide répond
   `409 Git Repository is empty`, et le plugin de nouvelles tentatives d'Octokit transforme ce 409
   en ~40 s de backoff (3 tentatives). Règle pour le module de provisionnement :
   ne jamais interroger les refs d'un dépôt qui vient d'être créé, et passer
   `request: { retries: 0 }` sur les appels dont les réponses 4xx sont porteuses de sens.
2. Pousser immédiatement après la création ne pose aucun problème (~1 s) : il n'y a aucun
   délai d'initialisation du côté de GitHub à cette échelle.
3. Chronométrage typique d'un provisionnement : création ~2,4 s, push ~1,1 s,
   ruleset ~0,7 s. Extrapolation pour 100 dépôts séquentiels ≈ 7 min ; avec la
   concurrence bornée à 10 prévue par l'architecture, très en deçà des
   contraintes (le budget de délai de rendu NFR-13 n'utilise de toute façon que des appels
   de ruleset, ~0,7 s).
4. `POST /orgs/{org}/repos` est annoncé comme déprécié (suppression en mars 2028) — prévoir
   la migration vers son remplaçant avant cette date (noté pour M2).

## Travail restant (hors de portée sans un second compte)

- **Force push refusé sur un vrai compte étudiant** et contournement par l'admin de l'organisation (GH-41) : à
  rejouer avec `S2_STUDENT_LOGIN=<login>` dès qu'un compte étudiant de test est
  disponible ; la procédure couvre déjà l'invitation.
- **Quota d'invitations d'organisation / 24 h (C-07.3)** : non mesuré — le sonder
  consommerait le quota réel et enverrait de vraies invitations. Décision :
  conserver le limiteur de débit d'invitations avec un débit configurable prévu par
  l'architecture, et mesurer passivement lors du premier usage réel (M2
  journalise chaque invitation et toute erreur de quota).
