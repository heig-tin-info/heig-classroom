# ADR-009 — Déploiement sur VM unique, Docker Compose, Caddy, sauvegardes SWITCH

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Disponibilité cible 99 % pendant les semestres (NFR-08), sonde externe sur `/healthz`,
sauvegarde quotidienne avec RPO 24 h et RTO 4 h testés chaque semestre (NFR-16). Données
personnelles d'étudiants suisses : la LPD s'applique (NFR-07, H11) et l'hébergement en
Suisse évite toute question de transfert transfrontalier. L'exploitant est un enseignant.

## Décision

1. **Une VM applicative HEIG** (4 vCPU / 8 Go / 60 Go, Debian stable), **Docker Compose**,
   trois services : `caddy` (TLS automatique Let's Encrypt, HSTS, seul port exposé),
   `app` (image unique, front inclus, `restart: always`), `postgres` (volume local, non
   exposé). Les webhooks sont une route du monolithe derrière Caddy ; en dev, `smee.io` ou
   `cloudflared tunnel`.
2. Déploiement par `docker compose pull && up -d`, migrations au démarrage (avec lock),
   image versionnée par tag git, rollback par tag précédent.
3. **Sauvegardes** : `pg_dump -Fc` quotidien via conteneur cron sidecar, copie hors VM vers
   le **stockage objet institutionnel suisse** (SWITCH ou HEIG, transfert chiffré),
   rétention 30 jours. Test de restauration **chronométré** une fois par semestre.
4. **Observabilité orientée exigences** : `/healthz` (DB, pg-boss, horloge) sondé à 60 s ;
   `/metrics` Prometheus exposant l'âge du plus vieux webhook non traité, le lag de la file,
   les jobs en dead-letter, le quota GitHub restant et le retard du ticker ; écran
   d'administration technique minimal (dead-letter avec relance).

## Conséquences

- Trois conteneurs, un fichier compose, un Caddyfile de quinze lignes : le déploiement
  complet se reconstruit de zéro en moins d'une heure.
- La restauration suit le runbook : VM neuve, dépôt d'infra, secrets depuis le coffre
  (ADR-010), `pg_restore`, DNS, réconciliation GH-62 — les crons résorbent la fenêtre
  perdue (ADR-011). RTO 4 h validé par le test semestriel.
- Données et sauvegardes en Suisse : argumentaire LPD clos.

## Alternatives rejetées

1. **Hébergeur cloud étranger ou stockage de sauvegarde hors Suisse** (Backblaze cité par la
   proposition robustesse) : défendable chiffré, mais ouvre une question LPD de transfert
   évitable — le stockage institutionnel l'élimine.
2. **Kubernetes, PaaS managé** : capacité d'exploitation disproportionnée, dépendances
   externes et coûts récurrents sans gain sur les NFR.
3. **Sonde et métriques minimales seulement** (proposition simplicité initiale) : la revue a
   retenu l'observabilité de la proposition robustesse — sans elle, le diagnostic d'une
   rafale de deadline se ferait au SQL brut dans les tables pg-boss.
