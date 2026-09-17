# Analyse critique du dossier de cadrage

Réponse à [project.md](../project.md) · 2026-09-17

Ce document fait ce que la section 1 du dossier demande : contester les choix des sections 7, 9 et 10, nommer les angles morts, et proposer un découpage réaliste. Les sections 3 et 4 (exigences, non-objectifs) sont prises comme contrat et ne sont pas rouvertes. Chaque arbitrage se termine par une décision, pas par une liste d'options.

Contexte matériel vérifié sur le poste de développement (WSL2, Ubuntu 26.04) : noyau 6.18 avec `nf_tables`, `nft_reject`, `br_netfilter` chargé, cgroup v2, systemd actif, sous-UID déjà alloués à l'utilisateur, 24 cœurs, 31 Go. Podman et nftables sont installables depuis les dépôts (podman 5.7, nftables 1.1, netavark 1.16, passt) mais **non installés**. Docker Desktop est présent côté Windows mais non intégré à cette distro, et il ne doit pas l'être (voir D1).

## 1. Verdict d'ensemble

Le dossier est solide sur le fond : les deux régimes, les points d'application par exigence, le refus de Codespaces pour E10, la position "portail mince au-dessus de briques", l'ordre des jalons. Rien de tout cela n'est remis en cause.

Il pêche sur trois points, tous en section 7, et tous dans le même sens : il construit un mécanisme là où une propriété structurelle donnerait la même garantie pour moins de code.

1. **Le filtrage réseau** est pensé comme une politique nftables dynamique par conteneur. Un réseau `internal` sans passerelle donne la même garantie sans une seule règle par session.
2. **Le canal Git** implémente le protocole HTTP intelligent dans le portail et injecte un jeton dans le conteneur. Un dépôt nu de transit servi par `git http-backend`, authentifié par l'adresse source du conteneur, supprime le protocole à écrire et le secret dans le conteneur.
3. **La sauvegarde périodique** commit dans le dépôt de l'étudiant toutes les deux minutes. Cela pollue son historique et répond à un risque que le volume persistant couvre déjà ; le vrai risque (tampons non enregistrés, disque hôte) se traite par l'autosave de l'éditeur et un instantané côté hôte.

Il a en outre deux angles morts sécuritaires (section 4 ci-dessous) : le conteneur atteint l'hôte lui-même, et l'espace de travail d'examen ne doit jamais être amorcé depuis le dépôt de l'étudiant.

## 2. Décisions ouvertes : arbitrages

### D1. Podman rootful, réseau `internal`, pas Docker Desktop

**Décision : Podman en mode privilégié (rootful), `--userns=auto`, un réseau ponté `internal` dédié, DNS désactivé dans les conteneurs.**

Le dossier a raison sur le rootless : pasta et slirp4netns déplacent la pile réseau en espace utilisateur et rendent nftables inopérant sur ce trafic. Il a aussi raison sur le compromis "moteur privilégié + espaces de noms utilisateur". Ce qui tranche entre Docker et Podman, c'est la granularité de l'espace de noms :

- Docker `userns-remap` applique **une seule** plage de sous-UID à tous les conteneurs du démon. Deux étudiants qui s'évadent atterrissent sur le même UID hôte.
- Podman `--userns=auto` alloue **une plage distincte par conteneur**. C'est littéralement l'exigence de la section 7 ("un espace de noms utilisateur distinct par conteneur"). Docker ne la satisfait pas.

Sur le filtrage, le dossier surestime le travail. Un réseau créé avec `podman network create --internal --disable-dns --gateway <ip>` n'a ni route par défaut ni NAT : un processus dans le conteneur ne joint **rien** hors du sous-réseau du pont, par construction. La liste blanche se réduit alors à ce qui écoute sur l'IP du pont côté hôte, c'est-à-dire le portail. **Vérifié le 2026-09-17 sur ce poste** (Podman 5.7, netavark) : avec la passerelle explicite, le pont porte l'adresse côté hôte, un serveur HTTP lié à cette adresse répond au conteneur, et `1.1.1.1` est injoignable par absence de route. Sans `--gateway`, un réseau `internal` n'attribue **aucune** adresse au pont et l'hôte est injoignable : l'option est obligatoire, pas cosmétique. Il reste deux règles nftables **fixes**, jamais modifiées par session :

1. Interdire le trafic conteneur ↔ conteneur sur le pont. Sans elle, deux étudiants communiquent par le réseau pendant un examen ; mesuré ouvert sur ce poste, **y compris en IPv6 lien-local** (`fe80::/64`), que Podman attribue même sur un réseau sans IPv6. **Correction après P2** : la famille `bridge` de nftables n'existe pas dans le noyau WSL (module absent). La règle est donc écrite en famille `inet`, hook `forward`, `iifname cs0 oifname cs0 drop`, avec `br_netfilter` chargé et `bridge-nf-call-iptables` et `-ip6tables` à 1 ; c'est le mécanisme de `docker --icc=false`, et `inet` couvre les deux protocoles. La variante `bridge` est livrée à part pour la VM de production. Le réseau est créé avec `--interface-name cs0` pour que les règles désignent un nom stable.
2. Restreindre ce que le pont peut atteindre sur l'hôte (famille `inet`, hook `input`, `iifname` du pont) au seul port du proxy Git. Voir l'angle mort 4.1.

Le DNS disparaît : `--dns=none` et `--add-host portal.internal:<ip du pont>`. Pas de résolveur à vues restreintes à exploiter, et le vecteur d'exfiltration DNS de la section 9 n'existe plus. Détail mesuré : sans `/etc/resolv.conf`, la libc retombe sur `127.0.0.1` et attend cinq secondes par résolution ratée ; l'image livre donc un `resolv.conf` sans `nameserver` avec `options timeout:1 attempts:1`, et l'échec prend deux millisecondes.

**Cycle de vie du pont.** netavark crée le pont quand le premier conteneur rejoint le réseau et le supprime quand le dernier le quitte. Un portail qui veut se lier à `10.77.0.254` avant la première session échouerait. Décision P2 : un **conteneur d'ancrage** permanent (`codespace-anchor`, alpine en `sleep infinity`, toutes capacités retirées, racine en lecture seule) maintient le pont et l'adresse. L'alternative, écouter sur `0.0.0.0` et filtrer en applicatif, exposerait le port Git sur toutes les interfaces et demanderait une règle nftables de plus pour moins de sûreté. Le ramasse-miettes du portail doit ignorer ce conteneur (label `heig-codespace.role=anchor`).

Le critère d'arbitrage du dossier est le bon et devient le test d'acceptation de la preuve C : depuis le conteneur, `curl` vers l'IP du pont sur le port Git réussit ; vers le pont sur tout autre port, vers 1.1.1.1, vers un autre conteneur, et toute résolution DNS échouent.

Deux pièges sur le poste de développement :

- **Docker Desktop est disqualifié.** Son démon tourne dans une autre distro WSL ; les règles nftables posées ici ne s'appliqueraient pas à ses ponts, et `--userns=auto` n'existe pas. Le projet doit vivre sur un Podman natif installé dans cette Ubuntu.
- Le portail doit parler au socket rootful (`/run/podman/podman.sock`). Qui contrôle ce socket est root ; le portail est donc **le** composant privilégié de l'hôte, et il faut l'assumer plutôt que le masquer par un sudo cosmétique.
- **Le binaire `podman` reste en mode local rootless tant qu'on ne passe pas `--remote`.** `CONTAINER_HOST` seul est ignoré. Une demi-journée de tests a été perdue le 2026-09-17 à mesurer un réseau pasta en croyant mesurer le pont rootful. Le module moteur invoque toujours `podman --remote --url unix:///run/podman/podman.sock`, et le poste déclare une connexion par défaut (`podman system connection add --default`). Détails dans [setup-poste.md](setup-poste.md).

### D2. gVisor : non en v1, décision reportée à la première séance d'examen réelle

L'argument juridique est réel mais prématuré. gVisor ajoute une compatibilité ptrace à éprouver, une seconde configuration de runtime à maintenir et à tester avant chaque examen, sur un système qui n'a pas encore fait une séance de travaux pratiques. Le durcissement de base (userns par conteneur, capacités nulles, seccomp, racine en lecture seule, pas de réseau) place déjà la barre au niveau d'un exploit noyau, hors modèle de menace de la section 9.

Le module moteur doit exposer le runtime comme paramètre d'image (`runtime: crun | runsc`) pour que le basculement soit un changement de configuration. C'est tout ce qu'on lui demande en v1.

### D3. Provisionnement des dépôts : consommer heig-classroom, ne rien réimplémenter

Le dossier hésite entre réimplémenter et consommer GitHub Classroom. Il oublie que [heig-classroom](/home/ycr/heig-classroom) fait déjà exactement cela : création des dépôts étudiants depuis un modèle, correspondance identité institutionnelle ↔ GitHub, GitHub App installée sur l'organisation, rattachement de compte. Le portail codespace ne crée pas de dépôt ; il reçoit l'URL du dépôt cible et la pousse.

Pour le portail de test, le dépôt cible est une ligne dans le fichier de devoir. Pour la production, c'est une requête à heig-classroom (ou une table partagée si les deux finissent dans le même processus, voir section 6).

### D4. SEB Server : ignoré

SEB Server est une pile Spring + base relationnelle + interface web dimensionnée pour un service d'examens à l'échelle d'une université. Pour vingt postes et une configuration SEB par devoir, générer un fichier `.seb` et servir un lien `sebs://` prend une centaine de lignes. La surveillance en temps réel qu'il apporte est déjà dans le tableau des sessions actives du portail. Position 1 du dossier. À rouvrir uniquement si l'établissement exploite déjà un SEB Server.

### D5. Session simultanée : reprise dans les deux modes, alerte en mode examen

code-server est conçu pour plusieurs onglets sur le même serveur ; "reprendre la session existante" est gratuit, c'est le comportement d'un second onglet sur un VS Code Web. Refuser demanderait de suivre les connexions websocket et d'en tuer une, avec un risque réel de refuser l'étudiant légitime dont l'onglet a planté.

Décision : une session vivante par couple (étudiant, devoir). Toute nouvelle ouverture y revient. En mode examen, si une requête arrive d'une **adresse client différente** de celle de la vérification SEB initiale, le proxy refuse et le tableau enseignant affiche une alerte. La sémantique est la même dans les deux modes ; seule la vérification de provenance diffère, ce qui est déjà le cas.

### D6. Un répertoire par couple (étudiant, devoir), monté par bind

Le dilemme "multiplie les objets" disparaît si le volume est un répertoire hôte `/srv/codespace/volumes/<étudiant>/<devoir>/` plutôt qu'un volume nommé du moteur. La sauvegarde est un `rsync` de l'arborescence ; l'inspection par l'administrateur est un `ls`. Le conteneur ne monte que le sous-répertoire `work/` ; le dépôt de transit et les instantanés vivent à côté, invisibles pour l'étudiant (section 3).

Piège concret pour les agents : avec `--userns=auto`, l'UID du conteneur est mappé sur une plage hôte différente à chaque démarrage. Le montage doit utiliser l'option `:U` de Podman (chown récursif vers la plage mappée) ou le portail doit fixer l'UID mappé par session avec `--uidmap`. C'est le genre de détail qui coûte une journée si on le découvre en jalon 3.

Pédagogie : l'isolement par devoir en mode examen est souhaitable (l'étudiant ne consulte pas ses travaux pratiques). En mode travaux pratiques, un enseignant qui veut un espace partagé entre devoirs le résout par un seul devoir "semestre". Pas d'option à exposer.

### D7. Supprimer la liste réseau de l'interface enseignant

Oui, sans réserve. Avec le réseau `internal` et les miroirs de documentation servis par le portail, la seule destination que le conteneur atteint est le portail, et ce n'est pas un réglage mais une propriété. Une liste d'exceptions, si elle devient nécessaire (un serveur de test d'un enseignant), est un attribut **d'image ou de profil administrateur**, posé en fichier de configuration sur l'hôte, pas un champ du formulaire de devoir.

### D8. Pile : celle de heig-classroom, sans discussion

Le dossier dit "aucune contrainte forte" et propose de choisir sur la qualité des bibliothèques. Les trois besoins qu'il cite sont couverts en Node : `@fastify/http-proxy` relaie les websockets, `git http-backend` se pilote en CGI depuis n'importe quel langage, et le moteur se pilote par sa ligne de commande ou son API REST. Aucune pile ne l'emporte techniquement ; ce qui l'emporte est la **réutilisation** :

- Fastify 5, TypeScript strict, Zod, Drizzle, `openid-client`, `octokit` : déjà en production dans heig-classroom, avec ADR et conventions.
- Le realm Keycloak de développement, le flux GitHub App et son rattachement de compte : réutilisables tels quels.
- Le mainteneur est le même et le code sera largement écrit par des assistants : un seul langage et un seul style comptent plus que tout.

Deux divergences assumées pour le portail de test :

- **SQLite via Drizzle** plutôt que PostgreSQL : un fichier, zéro service, sauvegarde par copie. Drizzle isole le choix ; le passage à Postgres est mécanique si les deux portails fusionnent.
- **Pas de React en v0.** Quelques pages HTML servies par Fastify suffisent au parcours étudiant et au tableau enseignant du jalon 1. L'interface riche vient au jalon 4, quand on saura ce qu'elle doit montrer.

Pilotage du moteur : la **ligne de commande `podman`** enveloppée dans un module unique (`engine.ts`), avec sortie `--format json`. Transparent, débogable à la main, et l'API libpod n'apporte rien à vingt conteneurs. Le module est le seul endroit qui connaisse Podman.

## 3. Section 7 : trois simplifications de fond

### 3.1 Canal Git : un dépôt de transit au lieu d'un protocole à écrire

Le dossier propose que le portail implémente le protocole Git HTTP intelligent et relaie vers GitHub, avec un jeton de session injecté dans la configuration Git du conteneur. Trois objections.

Un jeton de session dans le conteneur **est** un secret dans le conteneur. Court et révocable, mais exfiltrable pendant sa vie, ce qui contredit le titre de la section ("sans secret dans le conteneur"). Sur un pont géré par le portail, avec le trafic inter-conteneurs bloqué, **l'adresse IP source identifie la session** de façon fiable. Le portail sait quelle IP il a donnée à quel conteneur. Le remote est `http://portal.internal:<port>/git/<session>` et le proxy vérifie que la requête vient de l'IP de cette session. Zéro secret, zéro révocation.

Implémenter receive-pack est inutile : `git http-backend` le fait, en CGI, depuis vingt ans. Le portail pose les variables d'environnement (`PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `GIT_PROJECT_ROOT`), pipe le corps, relit les en-têtes CGI. Soixante lignes de Node, aucun protocole.

Relayer en direct vers GitHub fait dépendre le rendu d'un examen de la disponibilité de GitHub à l'instant du push. Un **dépôt nu de transit** par couple (étudiant, devoir), sur l'hôte à côté du volume, découple : le push de l'étudiant aboutit localement en quelques millisecondes et constitue la preuve de rendu horodatée (le `PushEvent` du dossier), puis un travail de fond relaie vers GitHub avec le jeton d'installation, avec reprise sur erreur. Le jeton ne quitte jamais la mémoire du portail.

Architecture retenue :

```
conteneur ──push──▶ portail:/git/<session>  (auth par IP source)
                       │  git http-backend  →  volumes/<e>/<d>/staging.git
                       │  enregistre PushEvent (ref, sha, horodatage)
                       └─ job relais ──push (jeton d'installation)──▶ GitHub
```

Effets secondaires bienvenus : le dépôt de transit est une seconde copie de l'historique poussé (E15, E17), et il donne la réponse à la question de section 13 sur `upload-pack` (3.2).

### 3.2 Le refus d'upload-pack ne protège pas ce qu'il croit protéger

Le dossier interdit le clonage et la récupération pour fermer "la voie par laquelle un étudiant introduirait un fichier d'extension". Deux failles dans le raisonnement.

D'abord, la voie n'est pas fermée : le dossier prévoit un clonage **au provisionnement**, depuis le dépôt de l'étudiant. Tout ce que l'étudiant a poussé depuis chez lui avant l'examen (un `.vsix`, un antisèche, une solution) arrive dans le conteneur. Voir l'angle mort 4.2.

Ensuite, la présence d'un fichier `.vsix` dans le conteneur n'est dangereuse que si l'installation est possible. Or l'étudiant a un terminal et peut invoquer le binaire code-server avec `--install-extension`. La seule barrière qui tienne est que le **répertoire d'extensions soit en lecture seule** (il est sur la racine en lecture seule) et que le répertoire de données utilisateur ne permette pas d'en créer un second. Avec cela, un `.vsix` dans le conteneur est un fichier inerte, qu'il arrive par pull, par frappe au clavier ou par encodage base64 dans un commit. E5 se joue dans l'image, pas dans le proxy Git.

Décision : `upload-pack` est **autorisé** sur le dépôt de transit dans les deux modes. Ce qui change entre les modes est **ce que le portail met dans le dépôt de transit** :

- Travaux pratiques : miroir du dépôt GitHub de l'étudiant, synchronisé au démarrage de session et sur demande. L'étudiant pull ses propres commits faits ailleurs. Confort normal.
- Examen : amorcé depuis le **modèle de l'enseignant** uniquement, jamais depuis le dépôt de l'étudiant. Pendant l'épreuve, l'enseignant peut pousser un correctif d'énoncé sur le modèle ; le portail le propage aux dépôts de transit ; les étudiants font `git pull`. C'est exactement la fonctionnalité que le dossier craignait de perdre.

### 3.3 Sauvegarde : autosave dans l'éditeur, instantanés côté hôte, pas de commit fantôme

Un commit automatique toutes les deux minutes sur une branche de travail dans le dépôt de l'étudiant pose plus de problèmes qu'il n'en résout : il interfère avec un merge ou un rebase en cours, il embrouille un débutant qui découvre des commits qu'il n'a pas faits, et il n'apporte rien contre les deux pertes réelles.

Les deux pertes réelles sont : un tampon d'éditeur jamais écrit sur disque, et la disparition du disque hôte. Le volume, lui, survit déjà à la coupure réseau, à la fermeture de l'onglet et à la mort du conteneur : c'est le point de la section "Persistance" et il est acquis.

Décision :

1. `files.autoSave: afterDelay` (une seconde) imposé dans les réglages machine de code-server, non modifiable par l'étudiant. Le tampon n'existe plus comme risque.
2. Un **dépôt fantôme côté hôte** (`volumes/<e>/<d>/shadow.git`, work-tree = `work/`), commité toutes les deux à trois minutes, invisible du conteneur. Il capture l'arbre de travail y compris ce que l'étudiant n'a pas commité, sans toucher à son dépôt. Il tranche les litiges ("j'avais écrit la fonction, elle a disparu") mieux qu'une branche visible. **Mesuré en V1** : le volume appartient à la plage d'UID du conteneur (`:U`) ; le portail en uid 1000 lit l'arbre grâce à l'umask 022, mais un `chmod 600` de l'étudiant fait échouer l'instantané, réduit alors à un commit partiel journalisé. Décision pour la production : l'instantané est pris par un **temporisateur systemd root**, le portail ne fait que déclarer les volumes actifs. C'est cohérent avec le fait que le portail ne doit pas pouvoir supprimer un volume non plus.
3. Sauvegarde hors hôte de `/srv/codespace/volumes` (rsync ou instantané du fournisseur de la VM), c'est l'exploitation ordinaire du jalon 5.

### 3.4 Pool préchauffé : à ne pas construire avant d'avoir mesuré

**Mesuré par P1 le 2026-09-17** sur l'image durcie (1,5 Go, code-server 4.137) : `podman run` rend la main en 0,18 s, `/healthz` répond en 0,6 à 1,0 s, la page du workbench est servie en 1 s. Le clone depuis le dépôt de transit est local. L'objectif de dix secondes est tenu avec un ordre de grandeur de marge. Le pool compliquerait l'appariement volume ↔ userns et introduirait une classe d'états ("préchauffé mais non attribué") dans l'orchestrateur. **Décision : pas de pool.** À remesurer à vingt sessions simultanées au jalon 1 ; seule une dégradation d'un facteur cinq rouvrirait la question.

### 3.5 Durcissement : détails qui comptent

- **CAP_SYS_PTRACE n'est pas nécessaire** pour `gdb ./prog` : gdb trace ses propres enfants, ce que Yama en portée 1 (valeur sur ce poste, et par défaut sur Ubuntu) autorise, et le profil seccomp par défaut permet `ptrace` depuis le noyau 4.8. Elle ne sert qu'à `gdb -p <pid>` sur un processus lancé depuis un autre terminal. Confinée par l'userns, elle est peu dangereuse ; décision : retirée par défaut, activable par profil d'image si l'enseignant l'exige.
- **`personality`** : le dossier a raison. Le profil par défaut n'autorise que cinq valeurs et exclut `ADDR_NO_RANDOMIZE` (0x40000). Sans cette entrée, gdb ne désactive pas l'ASLR et les adresses changent à chaque exécution, ce qui ruine un cours de débogage. Le profil seccomp du projet est le profil par défaut de `containers-common` plus cette valeur, rien d'autre.
- **Mémoire** : deux gigaoctets × vingt = quarante sur une machine de trente-deux. Surengagement tolérable (clangd sur un TP en C consomme quelques centaines de mégaoctets), mais poser la limite à 1,5 Go évite qu'un seul `make -j` déclenche l'OOM killer sur le voisin.
- **code-server** plutôt qu'openvscode-server : maintenance active, et surtout les options `--disable-file-downloads` et `--disable-file-uploads` qui n'existent pas ailleurs (angle mort 4.3). `--auth none` derrière le proxy, liaison sur l'IP du conteneur uniquement. Galerie neutralisée par `EXTENSIONS_GALLERY` vide en plus du `product.json`.
- **Extensions C** : `ms-vscode.cpptools` a une licence qui interdit son usage hors des produits Microsoft ; elle n'est pas sur Open VSX. L'image embarque `llvm-vs-code-extensions.vscode-clangd` avec le binaire `clangd` (sinon l'extension tente de le télécharger et échoue, réseau coupé) et `webfreak.debug` pour gdb. Les deux sont sur Open VSX et se sont installées au build sans incident (P1).
- **Réglages machine : pas immuables.** P1 n'a pas pu établir que code-server 4.137 honore la portée machine pour les sept réglages posés ; un étudiant peut donc les modifier depuis l'interface pendant sa session (ils reviennent au démarrage suivant, le répertoire de données étant un tmpfs). Conséquence : `extensions.allowed` et `files.autoSave` sont du confort, pas des barrières. La barrière E5 mesurée est le répertoire d'extensions en lecture seule ; le filet E15 doit donc être le dépôt fantôme côté hôte (3.3), pas seulement l'autosave.
- **Deux contraintes Podman 5.7 découvertes** : `--dns=none` est refusé avec `--network none` (le script ne le pose que sur un vrai réseau) ; les tmpfs `/run` et `~/.cache` doivent être montés `mode=1777` parce que Podman les crée `root:755` et que le conteneur tourne en uid 1000, les options `uid=`/`gid=` n'étant pas acceptées sur `--tmpfs`.

## 4. Angles morts du modèle de menace

### 4.1 Le conteneur atteint l'hôte

Sur un réseau `internal`, le conteneur ne sort pas, mais il joint **tout ce qui écoute sur l'IP du pont** : le portail entier (interface enseignant, callback OIDC), et en développement Keycloak, Forgejo, la base. Un étudiant en examen pourrait appeler l'API enseignant depuis son terminal si un jeton traînait, ou simplement sonder les services. Le dossier ne le mentionne pas.

Contre-mesure double : la surface Git écoute **seulement** sur l'IP du pont ; les autres surfaces du portail écoutent sur les autres interfaces. Et une règle nftables `input` sur le pont ne laisse passer que le port Git. Les deux, parce qu'une liaison d'adresse se casse par une variable d'environnement.

### 4.2 L'espace d'examen amorcé depuis le dépôt de l'étudiant

Traité en 3.2. C'est le contournement le plus simple et le plus probable du dispositif : préparer chez soi, pousser, retrouver en examen. Il faut l'inscrire dans le modèle de menace et dans le modèle de données : un devoir en mode examen a un dépôt **modèle** comme source et un dépôt **cible** par étudiant, créé vide ou depuis le modèle, jamais l'inverse.

### 4.3 Entrée et sortie de fichiers par le navigateur

L'explorateur de VS Code accepte le glisser-déposer de fichiers depuis le poste, et propose "Télécharger" au clic droit. En examen, c'est un canal d'entrée (antisèche depuis une clé USB si SEB laisse l'explorateur de fichiers accessible) et de sortie. Deux couches : `allowDownUploads` à faux dans la configuration SEB, et `--disable-file-downloads --disable-file-uploads` dans code-server. Le presse-papiers relève de SEB (`enablePrivateClipboard`).

### 4.4 Les clés SEB dans un parc mixte

Le Browser Exam Key dépend du **binaire** SEB (plateforme et version) et de la configuration. Une salle avec des Windows et des Mac produit deux BEK pour un même devoir. Le modèle de données doit porter une **liste** de BEK acceptés par devoir, pas un scalaire, et la procédure enseignant doit expliquer d'où on les lit (l'outil de configuration SEB les affiche).

La Config Key, elle, se calcule côté serveur depuis la configuration générée. L'algorithme de normalisation JSON (tri des clés, exclusion d'`originatorVersion`, sérialisation exacte) est piégeux ; les agents doivent porter l'implémentation de référence du plugin Moodle `quizaccess_seb` plutôt que la réinventer.

Le chiffrement du fichier `.seb` n'apporte rien à l'intégrité (la Config Key la garantit) et un mot de passe à saisir crée de la friction en salle. Décision : fichier non chiffré en v1.

### 4.5 Les en-têtes SEB et les websockets

Le dossier prévoit avec raison de vérifier à l'ouverture puis d'émettre un cookie. Il faut l'énoncer plus fort : il n'y a **aucune garantie** que SEB ajoute ses en-têtes aux mises à niveau websocket ni aux requêtes de service worker. Le proxy vers code-server ne doit **jamais** attendre d'en-tête SEB ; il ne connaît que le cookie de session, lié à la vérification initiale et à l'adresse client (D5). La preuve B doit tester précisément ce chemin.

### 4.6 L'URL sur laquelle SEB calcule ses hachés

Les deux en-têtes SEB sont `sha256(url + clé)` où l'URL est celle que le navigateur a demandée. Derrière un frontal TLS, le portail la reconstruit ; s'il la reconstruit depuis l'en-tête `Host` ou `X-Forwarded-Host`, l'étudiant choisit l'URL sur laquelle le haché est vérifié. Décision P4 : en production, l'origine publique est une constante de configuration (`SEB_PUBLIC_ORIGIN`), rien de ce que le client envoie n'entre dans le calcul.

## 5. Réponses aux quatre questions de la section 13

**Le canal Git sans secret est-il la bonne réponse ?** Oui sur le principe, non sur la forme. La forme la plus simple à garanties égales est : identification par IP source, `git http-backend` sur un dépôt de transit local, relais asynchrone vers GitHub par le portail. Moins de code, aucun secret dans le conteneur, rendu indépendant de GitHub.

**Le refus d'upload-pack est-il tenable ?** Il n'est ni tenable ni utile. La garantie visée se tient dans l'image (répertoire d'extensions en lecture seule, galerie neutralisée). Le pull est autorisé, et la protection d'examen consiste à amorcer le dépôt de transit depuis le modèle de l'enseignant.

**Ne pas partir de Coder est-il justifié ?** Oui. Ce que Coder remplacerait, l'orchestrateur, représente quelques centaines de lignes autour de `podman run`. Ce qui fait la valeur du projet (vérification SEB, canal Git, réseau coupé, réglages d'image) serait de toute façon à écrire à côté de Coder, et le réseau `internal` serait à imposer contre son modèle par défaut.

**L'interface enseignant tardive est-elle soutenable ?** Oui, parce que le premier enseignant est l'auteur du projet. Un devoir est un fichier YAML jusqu'au pilote. Une maquette non fonctionnelle n'apprendrait rien à n = 1 ; une séance de travaux pratiques vécue, si.

## 6. Relation avec heig-classroom

Les deux portails partagent l'identité (Switch edu-ID), la GitHub App, la notion de devoir et les étudiants. La tentation de fusionner est légitime et sera forte. Position pour maintenant : **dépôt séparé, pile identique, frontières de module dessinées pour un montage ultérieur comme plugin Fastify** dans heig-classroom. Concrètement : le portail codespace ne connaît les dépôts GitHub que par une interface `RepoProvider` (fichier YAML en v0, client heig-classroom ensuite), et sa base ne duplique pas la table des étudiants au-delà de l'identifiant institutionnel et du login GitHub.

Fusionner maintenant coûterait la vitesse d'itération du portail de test et exposerait la production de heig-classroom à un composant qui pilote un moteur de conteneurs en root. Plus tard, quand les invariants tiendront.

## 7. Ce que les agents ne peuvent pas faire

La **preuve A** (code-server dans le navigateur de SEB, sur la plateforme de la salle) demande un poste Windows ou macOS avec SEB installé. C'est un test manuel de l'auteur, cinq minutes, à faire tôt : ouvrir n'importe quelle instance code-server publique de test depuis SEB, vérifier l'éditeur, le terminal, et le rechargement de page. La probabilité d'échec est faible (SEB Windows 3 embarque Chromium, SEB macOS WebKit, les deux font tourner VS Code Web) mais un échec change le projet.

L'**installation de Podman** sur ce poste demande un mot de passe sudo. Commandes à passer une fois, à la main, avant de lancer les agents :

```bash
sudo apt install podman nftables crun netavark aardvark-dns passt uidmap
echo "containers:2147483647:2147483648" | sudo tee -a /etc/subuid /etc/subgid
sudo systemctl enable --now podman.socket
sudo podman info --format '{{.Host.NetworkBackend}} {{.Host.OCIRuntime.Name}}'
```

Ces commandes ont été passées le 2026-09-17 ; la procédure complète, avec les deux pièges rencontrés (répertoire du socket recréé en 0700 par tmpfiles, mode distant à forcer), est dans [setup-poste.md](setup-poste.md). Tout le reste du jalon 0 et du jalon 1 se fait en agents, voir [jalon-0.md](jalon-0.md).
