# ADR-010 — Secrets hors dépôt et hors base, coffre institutionnel chiffré

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Secrets serveur : clé privée PEM de la GitHub App, client secrets OIDC et GitHub OAuth,
secret webhook, secret cookie, PAT d'enregistrement des runners (ADR-007). AU-43 exige
qu'ils proviennent de l'environnement ou d'un gestionnaire de secrets, « jamais du dépôt ni
de la base ». Le runbook de restauration (RTO 4 h, NFR-16) doit pouvoir les réinjecter de
façon reproductible.

## Décision

1. **À l'exécution** : fichiers d'environnement sur la VM (propriétaire root, permissions
   600), clé PEM montée en lecture seule dans le conteneur ; jamais dans une image, un
   dépôt git ou la base.
2. **Pour la reprise** : copie de secours **chiffrée age** de chaque secret dans le coffre
   institutionnel (Vaultwarden HEIG ou équivalent), référencée par le runbook ; la
   restauration est un script qui déchiffre et repose les fichiers.
3. **Rotation documentée au runbook** : la GitHub App accepte **deux clés privées actives**
   pendant la bascule (génération, déploiement, révocation de l'ancienne) ; même procédure
   de bascule sans interruption pour les clés API teacher (AU-40) et le PAT runners
   (expiration 12 mois).
4. **Aucun secret dans les logs** : serializers pino dédiés masquant clés au-delà du prefix,
   `code` OAuth, cookies et en-têtes `Authorization` (AU-41).

## Conséquences

- Lecture stricte d'AU-43 satisfaite : rien dans le dépôt, même chiffré.
- La restauration ne dépend d'aucune manipulation de mémoire humaine : le coffre et le
  script rendent le RTO reproductible (faiblesse « KeePass manuel » corrigée).
- La compromission d'un secret a une réponse écrite : révocation immédiate côté GitHub ou
  IdP, rotation par la procédure à deux clés.

## Alternatives rejetées

1. **Secrets sops/age commités dans le dépôt d'infra** (propositions productivité et
   robustesse) : pratique et versionné, mais en tension littérale avec AU-43 (« jamais du
   dépôt ») ; la copie chiffrée vit donc dans un coffre séparé, pas dans git.
2. **Vault dédié (HashiCorp ou équivalent)** : un service stateful de plus à exploiter et à
   sauvegarder, disproportionné pour une dizaine de secrets.
3. **Secrets en base** : interdit par AU-43 et inutile — la base est sauvegardée hors site,
   ce qui élargirait la surface d'exposition.
