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
| `extension/` | source de `heig.codespace-statusbar`, empaquetée en `.vsix` au build |
| `run-hardened.sh` | `podman run` avec le durcissement obligatoire |
| `test.sh` | test d'acceptation P1 (41 assertions) |
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
| `heig.codespace-statusbar` | 0.1.0 | source locale `extension/`, empaquetée au build |
| `@vscode/vsce` (empaquetage seulement) | 4.0.0 | `ARG VSCE_VERSION`, `npx` dans l'étape `vsix` |
| Node de l'étape d'empaquetage | `node:22-slim` | empreinte `sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96` |

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

### Les deux réglages ajoutés après le premier essai réel (2026-09-18)

Retours 1 et 2 de [docs/pistes.md](../../docs/pistes.md), « Retours du premier
essai réel ». Les deux noms ont été **cherchés dans le paquet embarqué**, pas
retenus de mémoire : `grep` littéral dans
`/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js`
de l'image construite. `test.sh` § 7 rejoue les deux recherches, et sur la
déclaration complète, de sorte qu'un changement de version casse le test
plutôt que le comportement.

**1. Barre latérale secondaire masquée au démarrage.**

```json
"workbench.secondarySideBar.defaultVisibility": "hidden"
```

Preuve, telle qu'elle sort du paquet (minifié, tronqué) :

```js
"workbench.secondarySideBar.defaultVisibility":{type:"string",
 enum:["hidden","visibleInWorkspace","visible","maximizedInWorkspace","maximized"],
 default:"visibleInWorkspace", …}
```

Le défaut amont est `visibleInWorkspace` : c'est bien lui qui ouvrait une barre
vide, la vue de chat qui l'habitait étant désactivée par
`chat.disableAIFeatures`. `hidden` est la première valeur de l'énumération
déclarée. Les clés voisines relevées au passage, non utilisées :
`workbench.secondarySideBar.forceMaximized` (marquée `experimental`) et
`workbench.secondarySideBar.showLabels`.

**2. Raccourcis indépendants de la disposition clavier détectée.**

```json
"keyboard.dispatch": "keyCode"
```

Preuve :

```js
{id:"keyboard",order:15,type:"object",title:…,properties:{
 "keyboard.dispatch":{scope:1,type:"string",enum:["code","keyCode"],
   default:"code",markdownDescription:…,included:jo===2||jo===3},
 "keyboard.mapAltGrToCtrlAlt":{…,included:jo===1}}}
```

et, à l'usage :

```js
function Dwn(s){let o=s.getValue("keyboard"),e=o?.dispatch==="keyCode"?1:0; …}
```

VS Code Web n'a pas de disposition suisse romande ; il détecte « Swiss German »
et en déduit des raccourcis faux. `keyCode` fait dispatcher les raccourcis sur
le code de touche brut, donc indépendamment de la disposition détectée.

**La frappe n'est pas affectée.** Les caractères que l'étudiant tape viennent
du navigateur et de la disposition du système d'exploitation ; VS Code les
reçoit tels quels. `keyboard.dispatch` ne touche qu'à la résolution des
raccourcis clavier. Un `é`, un `à` ou un `<` continuent de s'écrire comme
ailleurs sur le poste.

## Extension de barre d'état `heig.codespace-statusbar`

Retour 3 de [docs/pistes.md](../../docs/pistes.md). Éditeur `heig`, nom
`codespace-statusbar`, version `0.1.0`. Source dans `extension/` :
JavaScript pur, deux fichiers utiles (`package.json`, `extension.js`), **aucune
dépendance, aucun bundler, aucun accès réseau, aucune télémétrie**.

### Ce qu'elle affiche

Deux éléments à droite de la barre d'état :

1. **le temps restant** jusqu'à l'échéance du devoir — « 1 h 23 min restantes »,
   rafraîchi toutes les 30 s, couleur d'avertissement
   (`statusBarItem.warningBackground`) sous dix minutes, « Échéance dépassée »
   au-delà. L'infobulle porte la date-heure locale du conteneur
   (`TZ=Europe/Zurich`) et le titre du devoir ;
2. **« Fermer »** — commande `codespace.close`, qui ouvre l'URL de retour avec
   `vscode.env.openExternal`.

Français dès que `vscode.env.language` commence par `fr`, anglais sinon.

### Ce qu'elle lit

Trois variables d'environnement du conteneur, et rien d'autre. Elles sont
posées par le portail au `podman run` (`src/sessions/manager.ts`,
`CONTAINER_ENV_KEYS`, puis `src/engine/index.ts`) :

| Variable | Contenu | Absente |
| --- | --- | --- |
| `CODESPACE_DEADLINE` | échéance ISO 8601 (`deadlineAt` de classroom, colonne `assignments.closes_at`) | pas de compte à rebours |
| `CODESPACE_RETURN_URL` | `${CLASSROOM_URL}/` pour une session née d'un jeton de lancement, `${PUBLIC_URL}/` sinon | pas de bouton « Fermer » |
| `CODESPACE_ASSIGNMENT_NAME` | titre du devoir | infobulle sans le titre |

**Aucun secret n'y entre** (invariant 1). Un test unitaire
(`src/sessions/containerEnv.test.ts`) affirme que le portail ne pose jamais de
quatrième clé, et `test.sh` § 9 compare l'environnement d'un conteneur lancé
par le portail à celui d'un conteneur nu : exactement trois lignes d'écart,
toutes en `CODESPACE_`.

### Comment elle reçoit cet environnement

L'hôte d'extensions de code-server est un processus Node **du serveur**, pas du
navigateur : l'extension déclare `"extensionKind": ["workspace"]` pour s'y
exécuter, et y lit `process.env`. L'héritage se fait en deux temps, tous deux
vérifiés par `test.sh` § 9 :

1. `code-server` (pid 1, qui porte les `-e` du `podman run`) engendre le
   serveur VS Code (`out/node/entry`) ; le test lit
   `/proc/<pid du serveur>/environ` et y retrouve les trois variables ;
2. ce serveur fork l'hôte d'extensions en construisant son environnement à
   partir du sien. Relevé littéralement dans `server-main.js` de l'image :

   ```js
   …catch(g){o.error("ExtensionHostConnection#buildUserEnvironment resolving shell environment failed",g)}
   let c={...process.env, …, VSCODE_ESM_ENTRYPOINT:"vs/workbench/api/node/extensionHostProcess", …}
   ```

### Empaquetage et installation

Le `.vsix` est fabriqué dans une **étape multi-stage** du `Containerfile`
(`FROM node:22-slim AS vsix`, `npx @vscode/vsce@4.0.0 package
--allow-missing-repository`) ; seul le `.vsix` entre dans l'image finale, pas
Node ni `vsce`. `--allow-missing-repository` est nécessaire : l'extension n'est
pas publiée et n'a pas de dépôt propre.

Elle est ensuite installée par `code-server --install-extension` **comme les
deux autres**, dans le même répertoire en lecture seule. Elle apparaît donc
dans `code-server --list-extensions` et dans `/etc/code-server/extensions.lock`
(le build échoue si elle en est absente), et elle est ajoutée à
`extensions.allowed` des réglages machine.

Le durcissement est intact : `test.sh` § 3 continue de vérifier qu'aucun
`.vsix` apporté par l'étudiant ne s'installe, et que le répertoire d'extensions
— celui de l'extension de barre d'état compris — n'est pas inscriptible.

### Limites

- **`openExternal` ouvre un nouvel onglet.** En travaux pratiques, le bouton
  « Fermer » ne ferme rien : il ouvre classroom (ou le portail) dans un onglet
  de plus et laisse l'éditeur derrière. C'est le comportement de
  `vscode.env.openExternal` dans VS Code Web, qui n'a aucun moyen de fermer
  l'onglet courant. Une vraie sortie demanderait une page du portail
  (« terminer la session ») ; c'est la piste 2 de docs/pistes.md, hors
  périmètre ici.
- **Le compte à rebours est indicatif.** Il ne ferme pas la session, ne bloque
  rien, et l'heure est celle du conteneur. Le portail ne s'en sert pas : la
  fenêtre d'ouverture d'un devoir reste décidée côté serveur
  (`sessions/store.ts`, `isOpen`).
- **Le titre de la commande dans la palette reste en français.** Les chaînes
  affichées par l'extension (barre d'état, infobulles, message d'erreur) sont
  choisies à l'exécution sur `vscode.env.language` ; le titre déclaré par le
  manifeste, lui, est statique. Le localiser demanderait `package.nls.json` +
  `package.nls.fr.json`, mécanisme correct mais non vérifiable sans navigateur ;
  écarté pour un titre que l'étudiant n'a pas besoin de lire, le bouton étant
  dans la barre d'état.
- **Un témoin d'activation** est déposé dans `/tmp/codespace-statusbar.json`
  (tmpfs) à l'activation, avec les trois variables telles qu'elles ont été
  lues. Il ne sert qu'au diagnostic ; il ne contient aucun secret et disparaît
  avec le conteneur.

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
- `TODO(verify)` **VS Code 1.137.0** — `workbench.secondarySideBar.defaultVisibility:
  hidden` : la clé, l'énumération et le défaut amont sont relevés dans le
  paquet embarqué, mais l'effet (barre absente à l'ouverture) demande un
  navigateur. À constater à la prochaine session réelle.
- `TODO(verify)` **VS Code 1.137.0** — `keyboard.dispatch: keyCode` : la
  déclaration porte `included: jo===2||jo===3`, où `jo` est le système
  d'exploitation détecté (`var jo = … ? 2 : … ? 1 : 3`, soit macOS / Windows /
  Linux). La clé n'est donc **enregistrée** que pour macOS et Linux ; sur un
  poste Windows elle reste une clé inconnue du registre de configuration. Le
  lecteur (`s.getValue("keyboard")?.dispatch === "keyCode"`) lit la
  configuration brute et devrait la voir quand même, mais cela n'a pas été
  constaté. À vérifier sur un poste Windows, qui est la plateforme de la salle
  d'examen.
- `TODO(verify)` **code-server 4.137.0** — l'hôte d'extensions n'a pas pu être
  démarré sans navigateur. `test.sh` § 9 mesure l'héritage jusqu'au **serveur**
  VS Code, qui est le processus qui fork l'hôte d'extensions, et relève dans le
  paquet que ce fork part de `{...process.env}`. Le maillon final se constate
  en ouvrant l'éditeur : le compte à rebours affiché **est** la preuve, et
  `podman exec <conteneur> cat /tmp/codespace-statusbar.json` la rend lisible.
  Deux tentatives de pilotage par Chromium sans interface (chrome-headless-shell
  et Chrome for Testing 153) se sont arrêtées sur la connexion de gestion, sans
  jamais atteindre la connexion d'hôte d'extensions.
- `TODO(verify)` **heig.codespace-statusbar 0.1.0 sous SEB** — en mode examen,
  `vscode.env.openExternal` demande au navigateur d'ouvrir une URL. Sous Safe
  Exam Browser, le filtre d'URL peut refuser l'ouverture, ou l'ouvrir dans une
  fenêtre supplémentaire que l'étudiant ne saura pas fermer. Comportement à
  observer à la première répétition en salle. Le domaine de classroom est déjà
  autorisé par le filtre (`sebAllowedHosts`), donc le refus, s'il arrive,
  viendra de la politique de fenêtres de SEB, pas du filtre d'hôtes.

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
