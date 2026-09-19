# ADR-009 — Déploiement sur une seule VM, Docker Compose, Caddy, sauvegardes SWITCH

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

La cible de disponibilité est de 99 % pendant les semestres (NFR-08), avec une sonde externe
sur `/healthz`, une sauvegarde quotidienne avec RPO 24 h et RTO 4 h testée chaque semestre
(NFR-16). Données personnelles d'étudiants suisses : la loi suisse sur la protection des
données s'applique (NFR-07, H11) et un hébergement en Suisse évite toute question de
transfert transfrontalier. L'exploitant est un enseignant.

## Décision

1. **Une VM applicative HEIG** (4 vCPU / 8 Go / 60 Go, Debian stable), **Docker Compose**,
   trois services : `caddy` (TLS Let's Encrypt automatique, HSTS, le seul port exposé),
   `app` (une image unique, front-end inclus, `restart: always`), `postgres` (volume local,
   non exposé). Les webhooks sont une route du monolithe derrière Caddy ; en développement,
   `smee.io` ou `cloudflared tunnel`.
2. Déploiement par `docker compose pull && up -d`, migrations au démarrage (sous verrou),
   image versionnée par tag git, retour arrière vers le tag précédent.
3. **Sauvegardes** : un `pg_dump -Fc` quotidien par un conteneur cron sidecar, copié hors de
   la VM vers un **stockage objet institutionnel suisse** (SWITCH ou HEIG, transfert
   chiffré), avec une rétention de 30 jours. Un test de restauration **chronométré** une fois
   par semestre.
4. **Observabilité pilotée par les exigences** : `/healthz` (BD, pg-boss, horloge) sondé
   toutes les 60 s ; un point d'accès Prometheus `/metrics` exposant l'âge du plus ancien
   webhook non traité, le retard de la file, les tâches en dead letter, le quota GitHub
   restant et le retard du ticker ; un écran minimal d'administration technique (dead letters
   avec rejeu).

## Conséquences

- Trois conteneurs, un fichier compose, un Caddyfile de quinze lignes : tout le déploiement
  peut être reconstruit de zéro en moins d'une heure.
- La restauration suit le runbook : VM neuve, dépôt d'infrastructure, secrets depuis le
  coffre (ADR-010), `pg_restore`, DNS, réconciliation GH-62 — les tâches cron absorbent la
  fenêtre perdue (ADR-011). RTO 4 h validé par le test semestriel.
- Données et sauvegardes en Suisse : l'argument de la protection des données est réglé.

## Alternatives rejetées

1. **Un hébergeur cloud étranger ou un stockage de sauvegarde hors de Suisse** (Backblaze,
   cité par la proposition robustesse) : défendable lorsqu'il est chiffré, mais cela ouvre une
   question évitable de transfert transfrontalier — le stockage institutionnel la supprime.
2. **Kubernetes ou un PaaS géré** : une capacité d'exploitation disproportionnée, des
   dépendances externes et des coûts récurrents sans gain sur les NFR.
3. **Une sonde et des métriques minimales seulement** (proposition simplicité initiale) : la
   revue a retenu l'observabilité de la proposition robustesse — sans elle, diagnostiquer une
   rafale liée à un délai de rendu supposerait du SQL brut dans les tables pg-boss.
