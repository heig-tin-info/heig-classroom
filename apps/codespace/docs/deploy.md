# Déploiement du portail sur une VM

Recette versionnée, rejouable, de la VM nue au poste de travail servi en HTTPS.
Tout ce qui est décrit ici est exécuté par `deploy/bootstrap.sh` et
`deploy/push.sh` ; rien n'est laissé à une manipulation manuelle.

Cible de référence : `code.chevallier.io` (Hetzner, Ubuntu 26.04.1, noyau 7.0,
2 vCPU, 3,7 Go de RAM, 38 Go de disque, pas de swap, ports 80 et 443 ouverts
par le pare-feu du fournisseur). Exécutée de bout en bout le 2026-09-17.

---

## 1. La recette, en deux commandes

```bash
# VM neuve : paquets, socket Podman, réseau clos, unités, Caddy, /etc/codespace/env
apps/codespace/deploy/push.sh --bootstrap

# ensuite, à chaque déploiement
apps/codespace/deploy/push.sh
```

`push.sh --bootstrap` fait, dans l'ordre : construction locale, `rsync` de
`deploy/ infra/ images/` vers `/srv/codespace/src`, exécution de
`bootstrap.sh` sur la VM, `rsync` de la release, bascule du lien, construction
de l'image étudiante si elle manque, redémarrage, attente de `/healthz` en
local puis en HTTPS.

Les deux scripts sont **idempotents** : rejoués, ils ne cassent rien et
n'écrivent pas deux fois. `bootstrap.sh` a été rejoué deux fois sur la VM déjà
en service, sans effet de bord ; `/etc/codespace/env`, qui porte les secrets,
n'est écrit que s'il n'existe pas.

Variables d'environnement reconnues par les deux scripts :
`CODESPACE_SSH` (défaut `root@code.chevallier.io`), `CODESPACE_DOMAIN`,
`CODESPACE_CLASSROOM_URL`, `CODESPACE_IMAGE_TAG`.

### Ce que `bootstrap.sh` pose

| # | Élément | Détail |
| --- | --- | --- |
| 1 | swap | `/swapfile` de 2 Go, `/etc/fstab`, `vm.swappiness=10` |
| 2 | paquets | `podman crun netavark aardvark-dns passt uidmap nftables caddy git curl rsync python3 nodejs` |
| 3 | `--userns=auto` | ligne `containers:2147483647:2147483648` dans `/etc/subuid` et `/etc/subgid` |
| 4 | socket Podman rootful | groupe `podman`, drop-in `SocketGroup`/`SocketMode`, **surcharge tmpfiles** |
| 5 | utilisateur | `codespace`, système, sans shell, membre de `podman`, `$HOME` en `/srv/codespace/var/home` |
| 6 | arborescence | voir § 2 |
| 7 | `br_netfilter` | `/etc/modules-load.d/codespace.conf` + `/etc/sysctl.d/99-codespace-bridge.conf` |
| 8 | configuration | `/etc/codespace/env`, secrets tirés de `/dev/urandom` |
| 9 | systemd | `codespace.service`, `codespace-net.service`, `codespace-shadow.{service,timer}` |
| 10 | Caddy | `/etc/caddy/Caddyfile`, TLS Let's Encrypt automatique |
| 11 | réseau clos | `infra/net/setup.sh` : réseau `codespace`, ancrage, tables nft |

Les deux pièges Podman de [setup-poste.md](setup-poste.md) sont traités :

- **`/run/podman` recréé en `0700 root:root`.** `/usr/lib/tmpfiles.d/podman.conf`
  le refait à chaque démarrage ; la surcharge `/etc/tmpfiles.d/podman.conf` du
  même nom (`D! /run/podman 0750 root podman`) prime. Vérifié après un
  redémarrage réel : `/run/podman` est en `750 root:podman`, et le service, qui
  tourne en `codespace`, joint le socket.
- **`--remote` obligatoire.** Aucun script de `deploy/` n'appelle `podman` nu :
  `push.sh` et les scripts d'`infra/` passent tous par
  `podman --remote --url unix:///run/podman/podman.sock`, via une fonction
  `pd()`. Sans lui le binaire bascule en rootless local et mesure autre chose.

---

## 2. Arborescence sur la VM

```
/srv/codespace/
├── src/                     rsync de apps/codespace/{deploy,infra,images}
│   ├── deploy/              bootstrap.sh, push.sh, shadow-snapshot.sh, Caddyfile
│   ├── infra/               net/, nft/, seccomp/   <- SECCOMP_PROFILE pointe ici
│   └── images/c-dev/        Containerfile de l'image étudiante
├── releases/
│   └── 20260917-201030/     arbre autonome (dist/, node_modules/, drizzle/) ~114 Mo
├── app -> releases/20260917-201030
├── volumes/                 <login>/<devoir>/{work,staging.git,shadow.git}   0750 codespace
└── var/
    ├── codespace.sqlite     + -wal, -shm (WAL)                              0640 codespace
    └── home/                $HOME de l'utilisateur du service

/etc/codespace/env           0640 root:codespace — TOUTE la configuration, trois secrets
/etc/caddy/Caddyfile
/etc/systemd/system/codespace{,-net,-shadow}.{service,timer}
/etc/tmpfiles.d/podman.conf  /etc/systemd/system/podman.socket.d/group.conf
/etc/modules-load.d/codespace.conf  /etc/sysctl.d/99-codespace-{bridge,swap}.conf
```

`infra/` existe en deux exemplaires : celui de `/srv/codespace/src` — le seul
utilisé à l'exécution, par les unités systemd et par `SECCOMP_PROFILE` — et
celui qui voyage dans la release parce que `pnpm deploy` copie tout le paquet.
Le second est inerte. Conséquence à connaître : **un retour arrière de
l'application ne revient pas en arrière sur `infra/`**. Le profil seccomp et
les règles nft sont versionnés et changent bien plus rarement que le code ; si
un jour l'un des deux devait suivre la release, il faudrait faire pointer
`SECCOMP_PROFILE` sur `/srv/codespace/app/infra/…`.

`seed/` voyage aussi et ne sert à rien en production : la graine YAML est le
mode autonome, elle passe par `scripts/seed.ts` qui n'est pas déployé (`tsx`
est une dépendance de développement). `push.sh` vérifie explicitement la
présence de `dist/server.js`, `drizzle/meta/_journal.json`,
`node_modules/better-sqlite3` et des deux paquets d'espace de travail, et
refuse un arbre qui contiendrait des dépendances de développement.

Détail qui a coûté une passe : **`pnpm deploy` applique les règles de
publication npm**, donc `dist/` — présent dans le `.gitignore` du paquet — n'est
pas copié. `push.sh` le recopie à la main, exactement comme le `Dockerfile` de
classroom recopie `apps/server/drizzle`.

---

## 3. Configuration et secrets

Tout vit dans **`/etc/codespace/env`**, lu par `EnvironmentFile=` de
`codespace.service`. Le fichier est en `0640 root:codespace` : le service le
lit, personne d'autre.

Trois secrets y sont tirés de `/dev/urandom` à la création, 48 caractères
alphanumériques chacun, et ne sont **jamais** réécrits par un `bootstrap.sh`
rejoué :

| Clé | Rôle |
| --- | --- |
| `CODESPACE_LAUNCH_SECRET` | HS256 partagé avec classroom. **La même valeur doit être posée côté classroom**, sans quoi `/launch` refuse tous les jetons. |
| `COOKIE_SECRET` | signature du cookie de connexion du portail |
| `EXAM_COOKIE_SECRET` | HMAC du cookie `exam_session` |

Le secret de lancement se lit sur la VM, et nulle part ailleurs :

```bash
ssh root@code.chevallier.io "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env"
```

Valeurs de production notables :

```
NODE_ENV=production   HOST=127.0.0.1   PORT=3100
PUBLIC_URL=https://code.chevallier.io   SEB_PUBLIC_ORIGIN=https://code.chevallier.io
CLASSROOM_URL=https://classroom.chevallier.io
SEB_VERIFIER=real                      (le mode simulé est refusé par loadConfig en production)
DATABASE_PATH=/srv/codespace/var/codespace.sqlite
VOLUMES_ROOT=/srv/codespace/volumes
SECCOMP_PROFILE=/srv/codespace/src/infra/seccomp/codespace.json
PODMAN_URL=unix:///run/podman/podman.sock
CODESPACE_NETWORK=codespace  CODESPACE_GATEWAY=10.77.0.254  CODESPACE_GIT_PORT=9418
CODESPACE_IMAGE=codespace/c-dev:4.137.0  CODESPACE_MEMORY=1536m  CODESPACE_CPUS=1
SESSION_GRACE_MS=600000  SESSION_GC_INTERVAL_MS=60000  SHADOW_INTERVAL_MS=86400000
OIDC_ISSUER=            (vide : voir § 4)
FORGE_KIND=github  FORGE_URL=https://github.com  FORGE_TOKEN=   (voir § 5)
TRUST_PROXY=            (interdit en production : voir § 6)
```

**Plafond de sessions simultanées** : 3,7 Go de RAM, `CODESPACE_MEMORY=1536m`
par session, environ 600 Mo pour l'hôte et le portail. Deux sessions tiennent,
une troisième entame le swap. Le quota par enseignant (`quota.maxActiveSessions`
du `PUT`) est le seul garde-fou ; il vient de classroom et doit être posé en
conséquence sur cette VM.

### Surcharger un réglage pour un essai

Un `Environment=` de drop-in **ne l'emporte pas** sur l'`EnvironmentFile=` du
fichier principal — mesuré, la valeur du fichier gagne. Il faut un second
`EnvironmentFile`, appliqué après :

```bash
printf 'SESSION_GRACE_MS=5000\nSESSION_GC_INTERVAL_MS=2000\n' > /etc/codespace/env.test
chown root:codespace /etc/codespace/env.test && chmod 0640 /etc/codespace/env.test
mkdir -p /etc/systemd/system/codespace.service.d
printf '[Service]\nEnvironmentFile=/etc/codespace/env.test\n' \
  > /etc/systemd/system/codespace.service.d/zz-test.conf
systemctl daemon-reload && systemctl restart codespace.service
# … puis, sans faute, retour à la production :
rm -f /etc/systemd/system/codespace.service.d/zz-test.conf /etc/codespace/env.test
systemctl daemon-reload && systemctl restart codespace.service
```

---

## 4. Pas de fournisseur d'identité sur cette VM

Switch edu-ID n'est pas déclaré et il n'y a pas de Keycloak de production. Les
étudiants arrivent **tous** par le jeton de lancement de classroom
([integration-classroom.md](integration-classroom.md)). `OIDC_ISSUER` vide dit
exactement cela :

- `/auth/login`, `/auth/callback` et `/auth/logout` ne sont **pas enregistrées**
  et répondent 404 ;
- une page qui exige un utilisateur (`/`, `/teacher/sessions`) répond **503**
  avec un texte qui nomme la cause, au lieu de rediriger vers un 404 ;
- `/launch`, `/api/assignments/*`, le proxy et le canal Git sont entiers.

Ce n'est pas un raccourci d'identité : l'invariant 4 dit que la connexion OIDC
est réelle, et elle l'est — elle est absente, pas remplacée. Il n'existe aucune
autre façon de devenir `request.user`. La découverte OIDC était **déjà
paresseuse** avant ce déploiement (`OidcProvider.configuration()` : un IdP
injoignable n'empêche pas le démarrage) ; ce qui manquait était le cas
« aucun IdP du tout ». Quatre tests unitaires le couvrent
(`src/auth/oidcDisabled.test.ts`).

Pour brancher l'IdP plus tard : poser `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, et **ajouter les hôtes d'edu-ID à
`SEB_EXTRA_ALLOWED_HOSTS`** — sans quoi le filtre d'URL de Safe Exam Browser
bloquerait la page de connexion (analyse.md, docs/pistes.md).

---

## 5. Pas de GitHub App non plus

`FORGE_KIND=github` sans `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` /
`GITHUB_APP_INSTALLATION_ID`. Le portail construit alors une forge **partielle** :
tout ce qui ne demande pas de jeton fonctionne — en particulier l'URL de clonage
publique, dont le dépôt de transit s'amorce en mode travaux pratiques — et le
relais refuse explicitement.

Conséquence, vérifiée sur la VM avec un vrai `git push` depuis le conteneur :

- le push de l'étudiant **réussit** et le `PushEvent` est écrit (invariant 7) ;
- la ligne reste `pending`, avec dans `last_error` :
  « GitHub App non configurée : GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY et
  GITHUB_APP_INSTALLATION_ID sont absents. Le rendu est enregistré et reste en
  attente de relais. » ;
- elle ne passe **jamais** `failed` : une forge non configurée n'est pas une
  panne, et épuiser le budget de tentatives ferait perdre un rendu qui n'a
  jamais eu de destination. Poser les identifiants suffit à vider la file, le
  relais reprend seul.
- le service n'est pas affecté : une tentative toutes les minutes, sans appel
  réseau (l'erreur est levée avant).

Le branchement réel de la GitHub App est hors périmètre de ce déploiement.

---

## 6. L'adresse du client derrière Caddy

`TRUST_PROXY` est, dans `src/auth/config.ts`, un **booléen de développement** :
il pose `trustProxy: true` sur Fastify, ce qui rend `request.ip` contrôlable
par n'importe quel `X-Forwarded-For` venu de n'importe où. `loadConfig()`
refuse de démarrer avec, en production. C'est correct et on ne l'a pas touché.

Conséquence assumée ici : **derrière Caddy, `request.ip` vaut `127.0.0.1` pour
tout le monde.** Ce que cela change, exactement :

- le canal Git n'est **pas** concerné : il écoute sur `10.77.0.254:9418`, pas
  derrière Caddy, et l'authentification par adresse source du conteneur
  (invariant 1) est intacte ;
- le cookie de session du proxy n'est pas concerné : il est lié à la session,
  pas à l'adresse ;
- **le mode examen l'est.** Le cookie `exam_session` porte l'adresse du client
  relevée à la vérification SEB, et `checkExamRequest` la recompare à chaque
  requête du proxy (analyse.md D5). Avec `127.0.0.1` des deux côtés, la
  comparaison est vraie pour tout le monde : elle ne distingue plus deux postes.

Ce n'est pas bloquant tant qu'aucun examen ne tourne sur cette VM — le
déploiement actuel ne sert que le mode travaux pratiques — mais **c'est à
corriger avant la première épreuve**. Proposition, à instruire avec son test :

> Une variable distincte, par exemple `TRUSTED_PROXY_IPS=127.0.0.1,::1`,
> passée telle quelle à `trustProxy` de Fastify, qui accepte une liste
> d'adresses ou de CIDR. Fastify ne remonte alors la chaîne `X-Forwarded-For`
> que pour un saut dont l'adresse figure dans la liste ; un client qui forge
> l'en-tête depuis l'extérieur ne peut rien, puisque son saut immédiat vers
> Caddy n'est pas de confiance. C'est le réglage correct derrière un frontal
> maîtrisé, et il n'a rien à voir avec le `TRUST_PROXY` booléen, qui doit
> rester interdit en production.

Le repli sans code, si l'échéance pressait : lier le portail à une seconde
adresse et faire passer les sessions d'examen par un chemin qui ne traverse pas
le frontal. Il n'est pas recommandé — il casse TLS.

---

## 7. Le dépôt fantôme, pris en root

`analyse.md § 3.3` et `docs/v1.md § D-V1-1` laissaient deux pistes pour
l'instantané du dépôt fantôme ; la piste préférée — **un temporisateur systemd
root** — est celle qui est déployée.

`codespace-shadow.timer` lance `deploy/shadow-snapshot.sh` toutes les trois
minutes. Le script fait exactement ce que fait `snapshot()` de
`sessions/shadow.ts` — `info/exclude` à `.git`, `add -A --ignore-errors`, commit
seulement s'il y a de l'indexé, identité du portail — mais en root, donc sans le
problème de permissions. Le dépôt reste la propriété de `codespace`, et le
script passe `-c safe.directory='*'`.

Vérifié sur la VM : un fichier créé dans le conteneur en `chmod 600` — le cas
exact que `sessions/shadow.ts` ne sait pas capturer — **est dans l'instantané**.

Le temporisateur interne du portail est repoussé à 24 h
(`SHADOW_INTERVAL_MS=86400000`) pour qu'il n'y ait qu'un seul écrivain sur
`shadow.git`. L'instantané de fermeture de session, lui, reste en place : c'est
un filet, et il fonctionne.

Détail lié, et c'est une décision de l'unité : **`UMask=0022`, pas `0027`.**
`work/` est créé par le portail puis rechown par Podman (`:U`) vers la plage
d'UID du conteneur, **modes conservés**. En `0750`, le portail ne peut plus
entrer dans l'arbre de travail qu'il vient de créer et son instantané de
fermeture échoue sur « this operation must be run in a work tree ». Mesuré, puis
corrigé. L'arborescence au-dessus est en `0750 codespace:codespace`, donc aucun
autre utilisateur de l'hôte ne traverse.

---

## 8. Redéployer, revenir en arrière, reconstruire

### Redéployer

```bash
apps/codespace/deploy/push.sh
```

Une nouvelle release horodatée, bascule du lien, redémarrage, attente de
`/healthz`. Les cinq dernières releases sont conservées, les plus anciennes
élaguées.

### Revenir en arrière

```bash
ssh root@code.chevallier.io bash -s <<'EOF'
ls -1 /srv/codespace/releases        # choisir la précédente
ln -sfnT releases/<horodatage> /srv/codespace/app
systemctl restart codespace.service
curl -sf http://127.0.0.1:3100/healthz
EOF
```

Les migrations Drizzle sont appliquées à l'ouverture de la base
(`openDb()` → `migrate()`), à chaque démarrage. Elles ne sont pas réversibles :
une release **antérieure** à une migration ne sait pas lire le schéma que la
release suivante a posé. Avant tout retour arrière qui franchit une migration,
restaurer la sauvegarde de la base prise avant le déploiement (§ 9). Tant que
`drizzle/` n'a pas changé entre les deux releases, le retour est immédiat et
sans risque.

### Reconstruire la VM de zéro

1. VM Ubuntu 26.04 neuve, clé SSH root en place, DNS `A`/`AAAA` posés, ports 80
   et 443 ouverts ;
2. `apps/codespace/deploy/push.sh --bootstrap` ;
3. restaurer `/srv/codespace/volumes` et `/srv/codespace/var/codespace.sqlite`
   depuis la sauvegarde, avec le service arrêté ;
4. recopier `CODESPACE_LAUNCH_SECRET` **depuis l'ancienne VM** dans
   `/etc/codespace/env` avant le premier démarrage, sinon classroom émet des
   jetons que la nouvelle VM refuse — ou poser la nouvelle valeur des deux
   côtés ;
5. `systemctl restart codespace.service`.

L'image étudiante est reconstruite automatiquement (1 à 2 min) si elle manque.

### Redémarrage de l'hôte

Rien n'est à faire : vérifié par un redémarrage réel. `podman.socket`,
`codespace-net.service` (qui recrée le réseau, l'ancrage et les deux tables nft
— aucun des trois ne survit à un `reboot`), `codespace.service`,
`codespace-shadow.timer` et Caddy remontent seuls, `/run/podman` revient en
`750 root:podman`, le pont `cs0` porte `10.77.0.254`, et `/healthz` répond en
HTTPS moins d'une minute après le retour de la machine.

---

## 9. Sauvegarde

Rien d'automatique n'est en place aujourd'hui, et c'est un manque assumé de ce
jalon. Les deux choses à sauvegarder :

```bash
# 1. les volumes des étudiants (travail + dépôts de transit + dépôts fantômes)
rsync -a --delete root@code.chevallier.io:/srv/codespace/volumes/ ./sauvegarde/volumes/

# 2. la base, à chaud et de façon cohérente (WAL) — pas un simple cp
ssh root@code.chevallier.io "python3 - <<'PY'
import sqlite3
s = sqlite3.connect('/srv/codespace/var/codespace.sqlite')
d = sqlite3.connect('/srv/codespace/var/backup.sqlite')
s.backup(d); d.close(); s.close()
PY"
rsync -a root@code.chevallier.io:/srv/codespace/var/backup.sqlite ./sauvegarde/
```

`sqlite3` en ligne de commande n'est pas installé ; l'API `backup` de `python3`
fait le même travail et est cohérente avec le journal WAL. Un `cp` du seul
fichier `.sqlite`, sans `-wal` ni `-shm`, rendrait une base amputée des
dernières écritures.

Ce qu'il faudrait, et qui reste à faire :

- une unité `codespace-backup.timer` quotidienne qui fait les deux ci-dessus
  vers un stockage **hors de la VM** (Hetzner Storage Box en `rsync`/`sftp`, ou
  un instantané de volume du fournisseur) ;
- une rétention (7 quotidiennes, 4 hebdomadaires) et surtout **une restauration
  vérifiée** : une sauvegarde qu'on n'a jamais restaurée n'est pas une
  sauvegarde ;
- les volumes appartiennent à des plages d'UID de conteneur (`--userns=auto`),
  donc la sauvegarde doit être prise en root et restaurée en root avec
  `--numeric-ids`, sinon les propriétaires sont perdus.

Ce qui n'a **pas** besoin d'être sauvegardé : `/srv/codespace/releases` (rejouer
`push.sh`), `/srv/codespace/src` (le dépôt), l'image étudiante (reconstruite).
`/etc/codespace/env` doit l'être, ou au minimum ses trois secrets.

---

## 10. Vérifications, et ce qu'elles ont donné

### Réseau clos

```bash
ssh root@code.chevallier.io bash -s <<'EOF'
systemctl stop codespace.service      # test.sh lie lui-même 10.77.0.254:9418
/srv/codespace/src/infra/net/test.sh
systemctl start codespace.service
EOF
```

L'arrêt du portail est **nécessaire** : `test.sh` lie ses deux serveurs de test
sur la passerelle, dont le port Git que le portail occupe déjà.

Résultat sur la VM, en root : **10 PASS, 1 FAIL, 0 BLOQUÉ**. Les dix assertions
d'invariant sont vertes, y compris les deux qui étaient `BLOQUÉ` sur le poste de
développement faute de root, et y compris l'IPv6 lien-local.

Le `FAIL` unique est une limite du **test**, pas une violation de l'invariant 2,
et le diagnostic a été fait :

> `sans la règle ICC, A -> B:8080 échoue quand même : autre chose bloque`

« Autre chose », c'est `table bridge codespace`. Le noyau de cette VM a la
famille `bridge` de nftables, que le noyau WSL du poste n'a pas : `setup.sh`
charge donc **aussi** `infra/nft/codespace-bridge.nft`, la défense en profondeur
prévue par `analyse.md D1`. La régression, elle, ne retire que la règle ICC de
la table `inet` ; la règle L2 reste et bloque. Mesuré, dans cet ordre :

| état | A → B:8080 |
| --- | --- |
| les deux tables chargées | bloqué |
| sans la règle ICC de `inet`, table `bridge` présente | bloqué |
| sans la règle ICC de `inet` **et** sans la table `bridge` | **joignable** |
| les deux tables rechargées | bloqué |

Autrement dit les deux règles bloquent, chacune suffit, et la défense en
profondeur est réelle sur cette VM. `TODO(verify)` / correction à porter dans
`infra/net/test.sh` (hors périmètre de ce travail) : la régression ICC doit
retirer la règle des **deux** familles avant de conclure, sinon elle est
structurellement rouge sur tout noyau qui supporte `bridge`.

### Surfaces exposées

Depuis le poste, vers `code.chevallier.io` :

| port | attendu | mesuré |
| --- | --- | --- |
| 443 | ouvert | ouvert, TLS Let's Encrypt valide (`CN=code.chevallier.io`, `issuer=Let's Encrypt`) |
| 80 | ouvert (redirection, ACME) | ouvert |
| 3100 | fermé | fermé/filtré |
| 9418 | fermé | fermé/filtré |
| 8080 | fermé | fermé/filtré |

Côté VM, `ss -ltn` : `127.0.0.1:3100` (le portail), `10.77.0.254:9418` (le canal
Git, sur le pont et rien d'autre), `*:80` et `*:443` (Caddy). Aucune autre
écoute.

```
$ curl -sS -D- -o /dev/null https://code.chevallier.io/healthz
HTTP/2 200
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
x-frame-options: SAMEORIGIN
```

### Preuve fonctionnelle

```bash
CODESPACE_LAUNCH_SECRET="$(ssh root@code.chevallier.io \
    "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env")" \
  pnpm --filter @hgc/codespace exec tsx deploy/smoke.ts
```

`deploy/smoke.ts` joue le rôle de classroom : il signe lui-même son jeton de
service et son jeton de lancement avec `signHs256`, comme `scripts/e2e.ts` § 9.
Il pousse un devoir `smoke-<date>` en mode `online`, dont le `sourceRepo` **et**
le dépôt du jeton sont `heig-tin-info/example-priority-queue` — un dépôt
**public** de l'organisation du cours, 7 Ko, C, branche `main`. En mode travaux
pratiques c'est le dépôt du jeton qui amorce le dépôt de transit, et il doit
être clonable sans jeton : aucun secret ne transite par là (docs/v1.md D-V1-8).
Aucun dépôt n'a été créé pour l'occasion.

Onze assertions, toutes vertes :

```
PASS  /healthz — {"ok":true}
PASS  PUT refusé sans jeton de service — 401
PASS  devoir synchronisé — 200 {"id":"smoke-2026-09-17","configKey":null,"sebLink":null}
PASS  /launch ouvre la session — 303 /s/47acd86e-…/
PASS  cookie cs_session posé par /launch (aucune seconde connexion)
PASS  aucun cookie OIDC n'est requis ni posé
PASS  c'est bien le workbench de code-server
PASS  101 Switching Protocols + Sec-WebSocket-Accept recalculé et conforme
PASS  websocket refusé sans cookie de session — statut 403
PASS  le même jeton est refusé au rejeu — 403
PASS  /auth/login répond 404, la page d'accueil répond 503
```

Contrôles faits sur la VM pendant la session :

- l'espace de travail contient `main.c`, `priority-queue.c`, `Makefile` — le
  dépôt de transit a bien été amorcé depuis le dépôt public ;
- `origin` vaut `http://portal.internal:9418/git/<session>` ;
- durcissement effectif du conteneur :
  `["no-new-privileges","seccomp=/srv/codespace/src/infra/seccomp/codespace.json"]`,
  `readonly=true`, `pids=256`, `mem=1536m`, `cpus=1`, `CapDrop` complet,
  `work/` appartenant à `2147484647` (la plage tirée par `--userns=auto`) ;
- un `git push` depuis le conteneur réussit, le `PushEvent` est écrit et reste
  `pending` avec l'erreur de § 5.

### Mesures relevées sur cette VM (2 vCPU, 3,7 Go)

| Mesure | Valeur |
| --- | --- |
| `podman build` de l'image étudiante, sans cache | **113 s** |
| Taille de l'image | 1,5 Go |
| Taille d'une release | 114 Mo |
| **Jeton de lancement → page workbench, en HTTPS** | **3,92 s / 4,22 s / 4,31 s** (trois passes) |
| Mise à niveau websocket seule, à travers Caddy | 233 / 251 / 257 ms |
| Jeton de lancement → websocket établi | 4,15 s / 4,48 s / 4,56 s |
| Fermeture par le ramasse-miettes (grâce de 5 s de test) | 4 à 6 s |
| Redémarrage du service → `/healthz` | 5 s |
| Reprise après `reboot` de la VM → `/healthz` en HTTPS | < 60 s |
| RAM au repos (portail + ancrage + Caddy) | 605 Mo utilisés sur 3,7 Go |

Les 4 s de bout en bout se décomposent en un `podman run` et l'attente du
`/healthz` du conteneur (mesuré à 0,6–1,0 s sur le poste de développement,
images/c-dev/README.md), plus le clone du dépôt public depuis GitHub, qui est la
part variable. L'objectif de dix secondes d'`analyse.md § 3.4` est tenu, et
**rien ici ne justifie un pool préchauffé**.

### Nettoyage après une passe de fumée

`smoke.ts` ne nettoie pas derrière lui, volontairement : il ne fait que ce qu'un
client fait. Le ménage :

```bash
# 1. fermer la session : pas de route publique pour ça (le portail n'a que
#    /teacher/sessions/<id>/close, derrière le rôle enseignant, donc derrière
#    l'OIDC absent). On passe par le ramasse-miettes, avec la grâce de test du
#    § 3, puis on remet la grâce de production.
# 2. le volume
ssh root@code.chevallier.io 'rm -rf /srv/codespace/volumes/smoke'
```

Restent en base, et **aucune route ne permet de les supprimer** : la ligne
`assignments` du devoir de fumée, la ligne `users` de l'étudiant `smoke`, la
ligne `sessions` à l'état `closed`, le `push_events` `pending` et les `jti`
consommés. C'est sans conséquence — le devoir de fumée n'apparaît que pour un
utilisateur connecté, et il n'y en a pas — mais c'est à savoir. Une suppression
demanderait soit une route d'administration (hors périmètre), soit un `DELETE`
direct dans SQLite, service arrêté.

---

## 11. Ce qui reste pour la production réelle

Par ordre de dette.

1. **Adresse du client en mode examen** (§ 6). Bloquant avant la première
   épreuve, pas avant les travaux pratiques.
2. **GitHub App** (§ 5) : `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
   `GITHUB_APP_INSTALLATION_ID` dans `/etc/codespace/env`. Le relais vide alors
   la file tout seul. La même App que classroom.
3. **Switch edu-ID** (§ 4) : `OIDC_*`, plus les hôtes d'edu-ID dans
   `SEB_EXTRA_ALLOWED_HOSTS`.
4. **Image depuis GHCR.** Aujourd'hui l'image est construite sur la VM, 113 s de
   2 vCPU pendant lesquels le portail n'a plus grand-chose. En régime de
   croisière elle doit venir d'un registre, comme celle de classroom : la CI la
   construit et la pousse sur `ghcr.io/heig-tin-info/codespace-c-dev:4.137.0`,
   `push.sh` fait un `pd pull` au lieu d'un `pd build`, et le `deploy.sh` de
   classroom montre le modèle de jeton éphémère passé par SSH pour le `login`
   d'un paquet privé — aucun identifiant de registre n'est stocké sur la VM.
5. **Pare-feu de l'hôte, en complément de celui de Hetzner.** Le pare-feu du
   fournisseur est aujourd'hui la seule barrière sur les ports d'écoute ; il est
   correct, mais il est hors de la recette et une modification dans la console
   web ne laisse pas de trace dans le dépôt. `table inet filter` existe sur la
   VM avec trois chaînes vides en `policy accept`. À poser : `input` en
   `policy drop`, avec `ct state established,related accept`, `iif lo accept`,
   `tcp dport {22, 80, 443} accept`, et **surtout pas** de règle qui touche à
   `cs0` — c'est le rôle de `table inet codespace`, qui doit rester le seul
   endroit qui parle du pont. À écrire dans `infra/nft/` avec son test, pas dans
   `deploy/`.
6. **Sauvegarde automatique** (§ 9).
7. **Correction de la régression ICC de `infra/net/test.sh`** (§ 10).
8. **Rotation des journaux du portail** : ils vont au `journal`, dont la taille
   est bornée par défaut. À vérifier (`journalctl --disk-usage`) avant une
   séance chargée.

## 12. `TODO(verify)`

- `TODO(verify)` **Caddy 2.6.2 (Ubuntu 26.04)** — `flush_interval -1` sur
  `reverse_proxy` : la directive est acceptée et la mise à niveau websocket
  passe (mesurée, 101 + `Sec-WebSocket-Accept` conforme), mais on n'a pas
  observé l'effet du réglage lui-même sur un flux long. Il est là parce que le
  `Caddyfile` de classroom en a besoin pour ses SSE ; s'il posait problème, il
  se retire sans conséquence pour le websocket.
- `TODO(verify)` **Podman 5.7.0 / Ubuntu 26.04** — `codespace-bridge.nft` se
  charge sur ce noyau (7.0) alors qu'il est refusé sur le noyau WSL du poste.
  La conséquence sur `infra/net/test.sh` est traitée au § 10 ; ce qui n'a pas
  été vérifié, c'est le comportement de la table `bridge` après une mise à jour
  de netavark qui changerait le nom d'interface.
- `TODO(verify)` **systemd 257 / Ubuntu 26.04** — `SystemCallFilter=@system-service`
  sur `codespace.service` : le portail démarre et tourne, y compris ses
  `execFile` de `podman` et de `git`. Aucun chemin rare (montée en charge,
  `podman build` déclenché depuis le portail — qui n'existe pas) n'a été
  exercé sous ce filtre.
