# images/c-dev — image étudiante durcie (tâche P1)

Environnement de travail d'un étudiant : chaîne C complète, `gdb` réellement
utilisable (ASLR désactivable), code-server sans réseau, sans galerie
d'extensions et sans écriture possible hors du volume de travail.

Cadre : [docs/jalon-0.md](../../docs/jalon-0.md) § P1,
[docs/analyse.md](../../docs/analyse.md) § 3.2, 3.4, 3.5 et 4.3,
invariants 1 et 3 de [CLAUDE.md](../../CLAUDE.md).

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `Containerfile` | image `codespace/c-dev` |
| `entrypoint.sh` | copie des réglages machine dans le `user-data-dir` tmpfs, puis `code-server` |
| `settings.json` | réglages machine, installés en `/etc/code-server/settings.json` |
| `resolv.conf` | résolveur vide, installé en `/etc/resolv.conf` |
| `run-hardened.sh` | `podman run` avec le durcissement obligatoire |
| `test.sh` | test d'acceptation P1 (33 assertions) |
| `../../infra/seccomp/codespace.json` | profil seccomp du projet |

## Versions épinglées

| Élément | Version | Épinglage |
| --- | --- | --- |
| Base | Debian 13.6 « trixie » slim | empreinte `sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f` |
| code-server | **4.137.0** (VS Code 1.137.0, commit `b11dabda`) | `ARG CS_VERSION`, `.deb` de la release GitHub `coder/code-server` |
| gcc | 14.2.0 (Debian 14.2.0-19) | dépôt Debian stable |
| gdb | 16.3 (Debian 16.3-1) | dépôt Debian stable |
| clangd | 19.1.7 | paquet `clangd` |
| git | 2.47.3 | dépôt Debian stable |
| `llvm-vs-code-extensions.vscode-clangd` | 0.6.0 | Open VSX, résolue au build |
| `webfreak.debug` | 0.27.0 | Open VSX, résolue au build |

Les deux extensions sont épinglées par identifiant seulement : Open VSX ne
garantit pas la disponibilité d'une version ancienne. La version effectivement
retenue au build est écrite dans `/etc/code-server/extensions.lock` **dans
l'image**, et le build échoue si l'une des deux manque. Aucun `.vsix` n'a eu à
être téléchargé à la main : `code-server --install-extension <id>` depuis Open
VSX (galerie par défaut de code-server) a fonctionné pour les deux.

## Construction et lancement

```bash
podman --remote --url unix:///run/podman/podman.sock \
  build -t codespace/c-dev:4.137.0 -t codespace/c-dev:latest images/c-dev

CTR_NAME=cdev-p1 VOL_DIR=/srv/codespace/volumes/demo images/c-dev/run-hardened.sh
images/c-dev/test.sh
```

`run-hardened.sh` accepte `CTR_NAME`, `VOL_DIR`, `IMAGE`, `NETWORK`,
`SECCOMP`, `PODMAN_URL`, `EXTRA_ARGS`. Il écrit l'identifiant du conteneur sur
la sortie standard. `NETWORK` vaut `none` pour P1 ; P2 le lancera avec
`NETWORK=codespace`.

## Mesures (2026-09-17, WSL2, 24 cœurs, Podman 5.7 rootful, crun, overlay)

| Mesure | Valeur |
| --- | --- |
| Build complet `--no-cache` | **45 – 51 s** (dont ~25 s de téléchargement du `.deb` de 233 Mo) |
| Build avec cache de couches | 4,0 s |
| Taille d'image | **1,50 Go** (1 499 111 868 octets) |
| `podman run` (retour de la commande) | 0,18 s |
| `podman run` → `/healthz` 200 | **0,61 – 0,76 s** à chaud, **1,0 s** au premier lancement après build (cache de pages froid). Mesure imprimée par `test.sh` : `MESURE_DEMARRAGE_SECONDES` |
| `podman run` → `GET /` (poste de travail HTML servi) | 0,95 – 1,01 s |

Lecture pour la décision « pool préchauffé » de
[docs/analyse.md § 3.4](../../docs/analyse.md) : le démarrage du conteneur
n'est pas le poste coûteux. Une seconde entre `podman run` et un poste de
travail servi, sur une image déjà locale, laisse plus de neuf secondes pour
l'authentification, la création du volume, l'amorçage du dépôt de transit et
le chargement du navigateur. **Rien dans cette mesure ne justifie de
construire un pool préchauffé.** À remesurer au jalon 1 avec vingt conteneurs
simultanés : la mesure ci-dessus est mono-conteneur, et le coût d'un
`--userns=auto` est en `chown` sur les couches, pas en `run`.

## Options de code-server : vérifiées dans `code-server --help` de la 4.137.0

Toutes les options exigées par jalon-0 § P1 existent dans la version épinglée.
Vérification faite en exécutant `code-server --help` dans l'image construite.

| Option | Présente en 4.137.0 |
| --- | --- |
| `--auth none` | oui |
| `--bind-addr 0.0.0.0:8080` | oui |
| `--disable-file-downloads` | oui |
| `--disable-file-uploads` | oui |
| `--disable-workspace-trust` | oui |
| `--disable-update-check` | oui |
| `--disable-getting-started-override` | oui |
| `--extensions-dir` | oui |
| `--user-data-dir` | oui |
| `--install-extension`, `--list-extensions`, `--force` | oui (build) |

`EXTENSIONS_GALLERY='{"serviceUrl":"","itemUrl":"","resourceUrlTemplate":""}'`
est pris en compte : le journal de démarrage affiche `Using custom extensions
gallery`, et `test.sh` en fait une assertion.

## Réglages machine

`/etc/code-server/settings.json` est copié par le point d'entrée dans
`/run/code-server/User/settings.json` **et** `/run/code-server/Machine/settings.json`
(le `user-data-dir` est un tmpfs, donc remis à neuf à chaque démarrage de
conteneur).

Les sept clés demandées sont présentes et leur nom existe bien dans le paquet
VS Code 1.137.0 embarqué (recherche littérale dans
`/usr/lib/code-server/lib/vscode/out`) :

`files.autoSave: afterDelay`, `files.autoSaveDelay: 1000`,
`extensions.autoUpdate: false`, `update.mode: none`,
`telemetry.telemetryLevel: off`, `chat.disableAIFeatures: true`,
`extensions.allowed` restreint à `llvm-vs-code-extensions.vscode-clangd` et
`webfreak.debug` (avec `"*": false`).

S'y ajoutent, non demandés mais cohérents : `extensions.autoCheckUpdates`,
`update.showReleaseNotes`, `workbench.startupEditor`,
`security.workspace.trust.enabled`, et `clangd.path: /usr/bin/clangd` +
`clangd.checkUpdates: false` — sans quoi l'extension clangd tente de
télécharger son binaire et échoue, réseau coupé (docs/analyse.md § 3.5).

## Résolveur : `/etc/resolv.conf` livré par l'image

Constat venu de P2 : avec `--dns=none` Podman n'écrit aucun `/etc/resolv.conf`,
et la libc retombe alors sur `127.0.0.1` avec **cinq secondes d'attente par
tentative**. Toute résolution ratée — `curl`, `git`, un téléchargement tenté par
clangd — fait patienter l'étudiant cinq secondes au lieu d'échouer tout de
suite.

L'image livre donc un `/etc/resolv.conf` statique **sans aucun `nameserver`**,
avec `options timeout:1 attempts:1`. Comme la racine est en lecture seule, ce
fichier vient de l'image et l'étudiant ne peut pas le remplacer : c'est le but.

Détail qui compte : le fichier est posé par `COPY`, **pas** par `RUN`. Pendant
un `RUN`, buildah monte son propre `/etc/resolv.conf` par-dessus ; un
`printf > /etc/resolv.conf` dans un `RUN` écrit dans le montage et disparaît
avec lui. Première tentative faite ainsi, image livrée sans le fichier, erreur
détectée en comparant le contenu à l'exécution.

Mesuré sur la version épinglée (Podman 5.7.0) :

| Lancement | `/etc/resolv.conf` vu dans le conteneur | `getent hosts example.invalid` |
| --- | --- | --- |
| `--network none` (P1) | celui de l'image | échoue en ~2 ms |
| `--dns=none` (P2) | celui de l'image | échoue en ~2 ms |
| pont par défaut, sans `--dns` | réécrit par Podman avec le résolveur de l'hôte | résout |

Autrement dit `--dns=none` **n'écrase pas** le fichier de l'image, et
`--network none` non plus. `test.sh` § 8 en fait deux assertions : absence de
`nameserver` dans le fichier vu à l'exécution, et échec de
`getent hosts example.invalid` en moins de deux secondes (mesuré : 0,16 s de
bout en bout, appel `podman exec` compris).

## Profil seccomp : `infra/seccomp/codespace.json`

Source : `/usr/share/containers/seccomp.json` du poste (paquet
`containers-common`, cohérent avec Podman 5.7.0). **Une seule entrée ajoutée**,
rien d'autre modifié, ni retiré, ni réordonné hors insertion :

```json
{
  "names": ["personality"],
  "action": "SCMP_ACT_ALLOW",
  "args": [{ "index": 0, "value": 262144, "valueTwo": 0, "op": "SCMP_CMP_EQ" }],
  "comment": "ADDR_NO_RANDOMIZE (0x40000) : requis par gdb set disable-randomization on (heig-codespace P1)",
  "includes": {},
  "excludes": {}
}
```

Les cinq valeurs de `personality` déjà autorisées par le profil amont sont
conservées : `0`, `8`, `131072` (0x20000), `131080` (0x20008), `4294967295`
(0xffffffff). L'entrée ajoutée est insérée juste après elles. Diff vérifié par
comparaison ensembliste des 40 entrées amont → 41 entrées projet : une ajoutée,
zéro supprimée, zéro modifiée, clés de tête (`defaultAction`, `architectures`,
`archMap`) identiques.

Régression couverte par `test.sh` § 2 : un conteneur témoin lancé avec le
profil **par défaut** donne trois adresses de `main` différentes sur trois
exécutions sous gdb ; avec le profil du projet l'adresse est stable à
`0x555555555139`. Si le témoin cessait de varier, `test.sh` échouerait plutôt
que de valider une assertion vide.

## Écarts assumés par rapport à la lettre de jalon-0 § P1

Aucun n'affaiblit le durcissement ; tous sont vérifiés par `test.sh`.

1. **`--dns=none` n'est pas posé quand `--network none`.** Podman 5.7 refuse la
   combinaison : `Error: conflicting options: dns and the network mode: none`.
   `run-hardened.sh` ajoute `--dns=none` dès que `NETWORK != none`, donc P2 le
   verra. Avec `--network none` il n'y a de toute façon aucun résolveur.
2. **`--tmpfs /run` et `--tmpfs /home/student/.cache` portent `mode=1777`.**
   Podman monte `/run` en `mode=755 root:root` et les tmpfs nommés sans `mode`
   héritent de `root:root` ; le conteneur tourne en uid 1000 et ne pouvait
   écrire ni son `user-data-dir` ni son cache (échec observé :
   `mkdir: cannot create directory '/run/code-server': Permission denied`).
   `uid=`/`gid=` ne sont pas des options `--tmpfs` acceptées par Podman
   (`unknown mount option "uid=1000"`), et `tmpcopyup` ne transporte pas la
   propriété. Les autres drapeaux (`rw,nosuid,nodev`) sont ceux de Podman.
3. **Paquets ajoutés à la liste de jalon-0** : `libc6-dev`, `binutils`
   (dépendances réelles de la chaîne C), `curl` + `ca-certificates` (téléchargement
   du `.deb` au build, et assertion `/healthz` du test), `procps`, `less`.
4. **`/home/student/.local/share/code-server/coder-logs` est un lien
   symbolique vers `/run/code-server/logs`.** Sans lui, code-server lève une
   exception non rattrapée au démarrage en tentant d'écrire ses journaux sur la
   racine en lecture seule. Le reste de `~/.local/share/code-server` reste sur
   la racine en lecture seule, donc le répertoire d'extensions **par défaut**
   n'est pas inscriptible — c'est le point de docs/analyse.md § 3.2 et
   `test.sh` en fait une assertion.
5. **`XDG_CONFIG_HOME` est redirigé vers le tmpfs, mais seulement dans
   `entrypoint.sh`**, jamais dans un `ENV` de l'image. Le shell de l'étudiant
   garde les valeurs par défaut : son `code-server --install-extension` vise
   bien un répertoire d'extensions en lecture seule.
6. **`/etc/resolv.conf` est livré par l'image** (section précédente), ce que
   jalon-0 § P1 ne demandait pas : sans lui, `--dns=none` coûte cinq secondes à
   chaque résolution ratée.
7. **`/etc/dpkg/dpkg.cfg.d/heig-man-pages`** réactive `/usr/share/man` avant
   l'installation des paquets : l'image `slim` l'exclut par dpkg et
   `manpages-dev` s'installait sans ses pages. Les autres exclusions de l'image
   slim (doc, locale, info) sont conservées.

## TODO(verify)

Marqués selon la convention de CLAUDE.md : version concernée entre parenthèses.
Aucun réglage n'a été retiré ; ceux dont l'effet n'a pas pu être constaté sont
listés ici.

- `TODO(verify)` **code-server 4.137.0 / VS Code 1.137.0** — `extensions.allowed` :
  la clé existe dans le paquet embarqué, mais son effet (refus d'une extension
  hors liste) n'a pas été constaté. Le test ne vérifie que sa présence dans les
  réglages copiés. La barrière qui tient est le répertoire d'extensions en
  lecture seule, elle, mesurée. À vérifier quand une session réelle sera
  ouverte dans un navigateur.
- `TODO(verify)` **code-server 4.137.0 / VS Code 1.137.0** — `chat.disableAIFeatures` :
  idem, clé présente dans le paquet, effet non constaté. Aucune extension de
  chat n'est installée, donc l'impact est nul en l'état.
- `TODO(verify)` **code-server 4.137.0** — portée réelle du fichier
  `Machine/settings.json` : seuls les réglages de portée `MACHINE` ou
  `APPLICATION` y sont honorés, et le classement de chacune des sept clés n'a
  pas été relevé dans le code minifié. Conséquence pratique à connaître :
  **un étudiant peut modifier ces réglages depuis l'interface pendant sa
  session** ; ils sont remis à neuf au démarrage de conteneur suivant puisque
  le `user-data-dir` est un tmpfs. Une immuabilité stricte demanderait un
  support de « policy » que code-server 4.137.0 n'expose pas.
- `TODO(verify)` **code-server 4.137.0** — `--disable-file-downloads` et
  `--disable-file-uploads` sont bien présentes dans `--help` mais leur effet
  (glisser-déposer et « Télécharger » du clic droit) demande un navigateur ;
  c'est une vérification manuelle du jalon 1, à consigner avec la preuve B.
  Seconde couche déjà prévue : `allowDownUploads: false` côté SEB
  (docs/analyse.md § 4.3).
- `TODO(verify)` **clangd 19.1.7 + extension 0.6.0** — le serveur de langage
  démarre-t-il sans `compile_commands.json` et sans réseau ? La configuration
  par défaut est déposée aux deux chemins que clangd lit réellement
  (`/home/student/.config/clangd/config.yaml` dans l'image, et
  `$XDG_CONFIG_HOME/clangd/config.yaml` recopié par le point d'entrée, dont
  hérite l'hôte d'extensions), mais son effet n'a pas été constaté faute de
  session dans un navigateur. À reprendre au jalon 1.
- `TODO(verify)` **webfreak.debug 0.27.0** — aucune configuration de lancement
  gdb n'est fournie dans l'image. À décider au jalon 1 : `launch.json` déposé
  dans le dépôt modèle de l'enseignant, ou fichier machine.

## Ce qui n'est pas couvert par P1

- Le réseau : `run-hardened.sh` lance en `--network none`. Le réseau clos
  `codespace`, les règles nftables et `--add-host portal.internal` sont la
  tâche P2. `test.sh` ne mesure donc aucune propriété réseau.
- `CAP_SYS_PTRACE` reste retirée (docs/analyse.md § 3.5) : `gdb ./prog`
  fonctionne, `gdb -p <pid>` sur un processus d'un autre terminal ne
  fonctionnera pas. C'est la décision, pas un défaut.
- La taille d'image (1,5 Go) est dominée par code-server (723 Mo installés).
  Aucun effort de réduction n'a été fait : l'image est locale, le `podman run`
  ne la transfère pas.
