# heig-classroom

Monorepo pnpm de deux applications déployées séparément :

| Chemin | Rôle | Déploiement |
| --- | --- | --- |
| `apps/server` + `apps/web` | HEIG GitHub Classroom : classes, devoirs, dépôts étudiants, notation par CI | classroom.chevallier.io, VM DigitalOcean 1 Go, **production en service** |
| `apps/codespace` | Portail d'environnements de développement supervisés (code-server, Podman rootful, mode examen SEB) | VM moteur dédiée, en test |
| `packages/domain`, `packages/contracts` | Règles métier pures et schémas Zod partagés | |

Spécifications et ADR dans `docs/` (classroom) et `apps/codespace/docs/` (portail). Chaque application a son propre `CLAUDE.md` avec ses invariants ; celui d'`apps/codespace` prime pour tout ce qui touche au portail.

## Production : règles absolues

- `classroom.chevallier.io` est en service pour des étudiants. **Tout push sur `main` déclenche la construction de l'image et son déploiement** (`.github/workflows/ci.yml`, `deploy.sh`). On travaille sur des branches ; `main` ne reçoit que des changements prêts à tourner.
- On ne stoppe pas le service, sauf nécessité de redémarrer ; on ne purge jamais la base ; on ne lance aucune migration destructive sans sauvegarde vérifiée (voir `deploy.md`).
- Le Dockerfile ne construit **que** `apps/server` et `apps/web` (`pnpm --filter '!@hgc/codespace' build`). Rien d'`apps/codespace` n'entre dans l'image de production.
- Le moteur de conteneurs du portail ne tourne **jamais** sur la VM de classroom : socket Podman root, nftables et image de 1,5 Go n'ont rien à y faire (956 Mio de RAM, base de production).

## Règle d'import

`apps/codespace` n'importe que `packages/*`, jamais `apps/server` ni `apps/web`. L'inverse aussi. Les deux applications se parlent par HTTP avec un jeton de lancement signé (à venir, jalon 2 du portail). Cette règle garde le portail extractible en projet indépendant.

## Développement

```bash
corepack enable pnpm && pnpm install
docker compose -f docker-compose.dev.yml up -d     # Postgres + Keycloak (classroom)
pnpm dev                                           # classroom sur :3000
pnpm build && pnpm typecheck && pnpm test          # les deux applications
pnpm --filter @hgc/codespace test:integration      # portail : exige Podman rootful, voir apps/codespace/docs/setup-poste.md
```

Les tests d'intégration du portail sont exclus du CI ; ses tests unitaires y tournent. Code et identifiants en anglais, documentation et commits en français.
