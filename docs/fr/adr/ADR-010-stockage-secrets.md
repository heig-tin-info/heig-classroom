# ADR-010 — Secrets hors du dépôt et hors de la base de données, dans un coffre institutionnel chiffré

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

Secrets du serveur : la clé privée PEM de la GitHub App, les secrets client OIDC et OAuth
GitHub, le secret des webhooks, le secret des cookies, le PAT d'enregistrement des runners
(ADR-007). AU-43 exige qu'ils proviennent de l'environnement ou d'un gestionnaire de secrets,
« jamais du dépôt ni de la base de données ». Le runbook de restauration (RTO 4 h, NFR-16)
doit pouvoir les réinjecter de manière reproductible.

## Décision

1. **À l'exécution** : des fichiers d'environnement sur la VM (appartenant à root,
   permissions 600), la clé PEM montée en lecture seule dans le conteneur ; jamais dans une
   image, un dépôt git ou la base de données.
2. **Pour la reprise** : une copie de sauvegarde **chiffrée avec age** de chaque secret dans
   le coffre institutionnel (HEIG Vaultwarden ou équivalent), référencée par le runbook ; la
   restauration est un script qui déchiffre et remet les fichiers en place.
3. **Rotation documentée dans le runbook** : la GitHub App accepte **deux clés privées
   actives** pendant la bascule (générer, déployer, révoquer l'ancienne) ; la même procédure
   de bascule sans interruption s'applique aux clés d'API des enseignants (AU-40) et au PAT
   des runners (expiration à 12 mois).
4. **Aucun secret dans les journaux** : des sérialiseurs pino dédiés masquent les clés
   au-delà de leur préfixe, le `code` OAuth, les cookies et les en-têtes `Authorization`
   (AU-41).

## Conséquences

- Une lecture stricte d'AU-43 est satisfaite : rien dans le dépôt, pas même chiffré.
- La restauration ne dépend d'aucune mémoire humaine : le coffre et le script rendent le RTO
  reproductible (la faiblesse du « KeePass manuel » est corrigée).
- La compromission d'un secret a une réponse écrite : révocation immédiate côté GitHub ou
  fournisseur d'identité, rotation par la procédure à deux clés.

## Alternatives rejetées

1. **Des secrets sops/age versionnés dans le dépôt d'infrastructure** (propositions
   productivité et robustesse) : pratique et versionné, mais en tension littérale avec AU-43
   (« jamais du dépôt ») ; la copie chiffrée vit donc dans un coffre séparé, pas dans git.
2. **Un Vault dédié (HashiCorp ou équivalent)** : un service à état de plus à exploiter et à
   sauvegarder, hors de proportion pour une douzaine de secrets.
3. **Des secrets dans la base de données** : interdit par AU-43 et inutile — la base est
   sauvegardée hors site, ce qui élargirait la surface d'exposition.
