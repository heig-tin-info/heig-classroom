# Portail d'environnements de développement supervisés

Dossier de cadrage · 2026-09-17

## 1. Objet du document

Ce document décrit un projet à construire. Il sert de base d'analyse, pas de spécification figée : les arbitrages restants figurent en section 10, et les hypothèses sont signalées comme telles.

Ce qui est attendu d'une analyse fondée sur ce document : une critique de l'architecture proposée, l'identification des angles morts, une contestation argumentée des choix techniques là où une meilleure option existe, et un découpage de développement réaliste. Les sections 7, 9 et 10 sont les plus utiles à challenger ; les sections 3 et 4 définissent le contrat et ne devraient pas être réinterprétées.

Contexte de production : une classe de vingt étudiants, une équipe technique réduite, aucune plateforme Kubernetes existante, budget d'infrastructure de l'ordre d'une machine virtuelle unique. Toute proposition qui suppose une équipe plateforme dédiée est hors sujet.

## 2. Contexte et besoin

Enseignement de la programmation système en C, avec compilation, débogage sous gdb et rendu par dépôt Git. Deux problèmes récurrents motivent le projet.

Le premier est l'hétérogénéité des postes. Chaque rentrée consomme des heures à faire installer une chaîne d'outils sur Windows, macOS et Linux, avec des différences de comportement qui polluent l'enseignement. Un environnement identique pour tous, accessible au navigateur, supprime ce coût.

Le second est l'évaluation. Depuis la généralisation des assistants de code, un travail pratique rendu à domicile ne mesure plus grand-chose. Il faut pouvoir organiser un travail noté en salle, surveillé, dans un environnement où l'assistance automatisée est absente et où la documentation autorisée est explicitement définie par l'enseignant.

### Les deux modes d'usage

Le système doit servir deux régimes qui partagent la même infrastructure mais pas les mêmes contraintes.

Mode travaux pratiques. Accès depuis n'importe quel navigateur, à n'importe quelle heure. Confort avant tout. Le verrouillage réseau du conteneur reste actif, car il garantit la reproductibilité de l'environnement, mais l'étudiant navigue librement dans son propre navigateur. Aucune prétention de contrôle.

Mode examen. Accès uniquement depuis Safe Exam Browser, sur poste de salle, sous surveillance humaine. La surface de navigation de l'étudiant est définie par l'enseignant. Le portail refuse toute session qui n'est pas authentifiée comme provenant d'une instance SEB correctement configurée.

Le mode est un attribut du devoir, pas une instance séparée. Cette distinction structure une grande partie des exigences qui suivent : plusieurs d'entre elles n'ont de sens qu'en mode examen, et les traiter uniformément conduirait à un système inutilement pénible en mode travaux pratiques.

## 3. Exigences

Chaque exigence porte un niveau (obligatoire, souhaitable, optionnel) et un point d'application, c'est-à-dire la couche technique qui la fait respecter. Le point d'application importe autant que l'exigence : plusieurs exigences apparemment simples se révèlent inapplicables à la couche où on les place spontanément.

| # | Exigence | Niveau | Point d'application |
| --- | --- | --- | --- |
| E1 | L'étudiant accède au service par une URL unique, sans installation préalable hors SEB | Obligatoire | Portail web |
| E2 | Authentification par identité institutionnelle OpenID Connect | Obligatoire | Portail, fournisseur d'identité |
| E3 | Rattachement du compte institutionnel à un compte GitHub, en un clic, avec récupération du login et de l'adresse | Obligatoire | Portail, GitHub App |
| E4 | Un VS Code fonctionnel se charge dans le navigateur, avec coloration, complétion et navigation de code C | Obligatoire | code-server dans le conteneur |
| E5 | L'étudiant ne peut installer aucune extension hors de la liste définie par l'enseignant | Obligatoire | Image, product.json, extensions.allowed, réseau |
| E6 | Aucun assistant de code n'est disponible dans l'environnement | Obligatoire | Image, réseau sortant |
| E7 | Terminal disponible, avec gcc, gdb, make, git, pages de manuel | Obligatoire | Image du conteneur |
| E8 | L'étudiant crée et modifie des fichiers, qui survivent à la fin de la session | Obligatoire | Volume persistant |
| E9 | L'étudiant peut pousser son travail vers un dépôt GitHub désigné | Obligatoire | Proxy Git du portail |
| E10 | Le conteneur n'atteint aucune destination réseau hors de celles explicitement autorisées | Obligatoire | nftables sur l'hôte |
| E11 | En mode examen, la surface de navigation de l'étudiant est limitée à une liste définie par l'enseignant | Obligatoire | Filtre d'URL de SEB |
| E12 | En mode examen, le portail refuse toute session hors SEB correctement configuré | Obligatoire | Vérification BEK et Config Key côté serveur |
| E13 | L'enseignant crée un devoir depuis une interface, sans intervention technique | Obligatoire | Portail |
| E14 | La session démarre en quelques secondes du point de vue de l'étudiant | Souhaitable | Pool de conteneurs préchauffés |
| E15 | Le travail n'est jamais perdu, y compris sur coupure réseau ou fermeture brutale | Obligatoire | Volume nommé, sauvegarde automatique périodique |
| E16 | Le conteneur est détruit après une période d'inactivité configurable | Souhaitable | Ramasse-miettes du portail |
| E17 | L'enseignant dispose d'une trace horodatée des rendus et des sessions | Souhaitable | Journal du proxy Git |
| E18 | Documentation de référence consultable pendant l'examen | Souhaitable | Miroirs locaux servis par le portail |

### Points d'attention sur les exigences

E5 repose sur trois couches superposées, aucune n'étant suffisante seule. Extensions cuites dans l'image, retrait du champ de galerie d'extensions dans le product.json de la build, et réglage extensions.allowed au niveau machine. Le comportement exact de ce réglage dans les builds dérivées de VS Code doit être vérifié empiriquement, il n'est pas garanti identique à celui du VS Code de bureau.

E9 et E10 sont en tension. L'approche naïve consiste à poser une clé SSH dans le conteneur et à ouvrir le réseau vers GitHub ; elle réintroduit un secret exfiltrable et une destination large. L'approche retenue est décrite en section 7.

E11 ne contrôle que ce que l'étudiant lit dans son navigateur. E10 ne contrôle que ce que les outils du conteneur atteignent. Ce sont deux listes distinctes, avec deux moteurs distincts et deux sémantiques distinctes. Les confondre dans l'interface enseignant est l'erreur de conception la plus probable de ce projet.

E12 est la clé de voûte du mode examen. Sans vérification côté serveur des clés transmises par SEB, l'étudiant ouvre simplement le portail dans un navigateur ordinaire et l'ensemble du dispositif de surveillance devient décoratif.

## 4. Non-objectifs et limites assumées

Ces points sont explicitement hors périmètre. Les rouvrir sans nécessité fera dériver le projet.

Ce n'est pas une plateforme multi-établissements, ni multi-classes à grande échelle. La cible est vingt étudiants simultanés, avec une marge raisonnable jusqu'à cent. Toute optimisation pensée pour mille utilisateurs est prématurée.

Ce n'est pas un système anti-triche complet. Le téléphone posé sur les genoux, le voisin, la montre connectée relèvent de la surveillance humaine. Le dispositif technique réduit une surface, il ne la supprime pas ; le prétendre serait malhonnête vis-à-vis des enseignants.

Ce n'est pas un système de notation ni un LMS. Pas d'énoncés, pas de barèmes, pas de correction automatique. Le portail livre un environnement et un canal de rendu ; ce qui se passe ensuite appartient aux outils existants.

Ce n'est pas une plateforme multilingue au sens des langages. Le premier périmètre est la chaîne C, avec gcc, gdb et clangd. L'extension à d'autres langages doit rester possible par simple changement d'image, sans refonte, mais n'est pas à traiter maintenant.

La navigation de l'étudiant n'est contrôlée qu'en mode examen. En mode travaux pratiques, il dispose de son navigateur complet et de tout l'internet. C'est assumé et souhaitable.

L'isolation visée est celle du conteneur durci, pas celle d'un hyperviseur. Le passage à gVisor ou à une micro-machine virtuelle est une option envisagée en section 10, pas une exigence initiale.

## 5. Acteurs et parcours

### Enseignant

Il se connecte au portail par son identité institutionnelle et crée un devoir. Le formulaire comporte : un intitulé, une image de conteneur choisie dans une liste courte, la liste blanche d'extensions VS Code, le dépôt GitHub cible ou le modèle dont il dérive, le mode (travaux pratiques ou examen), la fenêtre d'ouverture, la liste de documentation autorisée en mode examen, et la liste des destinations réseau autorisées pour le conteneur, vide par défaut.

À la validation, le portail produit les artefacts dérivés : en mode examen, un fichier de configuration SEB chiffré dont il conserve la Config Key, et le lien de lancement correspondant. L'enseignant récupère ce lien et le distribue.

Pendant la séance, il consulte un tableau des sessions actives, avec état, dernier battement et horodatage du dernier rendu. Il peut forcer la fermeture d'une session.

### Étudiant, mode travaux pratiques

Il ouvre le portail dans son navigateur habituel, s'authentifie, voit la liste de ses devoirs ouverts, clique sur Démarrer. Le portail alloue un conteneur, monte son volume, et le redirige vers son VS Code. Il travaille, commit, pousse. À la fermeture de l'onglet, le battement cesse ; après le délai de grâce puis le délai de rétention, le conteneur est détruit et le volume conservé.

### Étudiant, mode examen

Il lance Safe Exam Browser par le lien fourni. SEB télécharge la configuration, se verrouille en mode kiosque et ouvre l'URL de démarrage du portail. Le portail vérifie les clés transmises, refuse si elles ne correspondent pas au devoir, puis présente l'authentification institutionnelle. Le reste du parcours est identique, à ceci près que la surface de navigation est réduite à ce que l'enseignant a autorisé, et que les onglets de documentation sont servis depuis le portail.

### Administrateur

Il construit et publie les images, gère la liste des images disponibles aux enseignants, surveille la machine hôte et restaure un volume au besoin. Ce rôle n'a pas d'interface dédiée dans la première version ; il travaille en ligne de commande sur l'hôte.

### Parcours dégradés à traiter explicitement

Ces cas ne sont pas des détails. Ils constituent la moitié du travail réel et doivent figurer dans le découpage.

Le réseau de l'étudiant tombe pendant l'examen puis revient. La session doit se rétablir sans perte et sans nouvelle authentification complète.

Le conteneur meurt, par dépassement mémoire ou plantage. Le portail doit le redémarrer sur le même volume, sans que l'étudiant ait à comprendre ce qui s'est passé.

L'étudiant n'a pas rattaché de compte GitHub au moment de démarrer. Le portail doit le lui proposer sans perdre le contexte du devoir.

Un étudiant arrive en retard, ou avec un poste sur lequel SEB refuse de démarrer. Il faut une procédure de secours documentée, décidée avant la séance et non pendant.

Deux sessions simultanées sur le même devoir, par exemple un second onglet. Le comportement attendu doit être choisi : refus, reprise de la session existante, ou partage.

## 6. État de l'art et position retenue

### Ce qui a été écarté, et pourquoi

GitHub Codespaces avec GitHub Classroom couvre l'authentification, l'IDE navigateur, la persistance et le rendu Git sans une ligne de code. Il échoue sur E10 de façon structurelle : la documentation GitHub indique qu'il n'existe pas de moyen de restreindre l'accès d'un codespace à l'internet public, les codespaces étant autorisés à ouvrir des connexions sortantes. Le mode examen est donc hors d'atteinte. GitHub Classroom reste intéressant pour la seule création des dépôts étudiants depuis un modèle, à évaluer en section 10.

Coder, la plateforme auto-hébergée de développement à distance, est la candidate sérieuse. L'édition communautaire apporte le SSO OpenID Connect, des workspaces définis en Terraform sur Docker ou Kubernetes, le proxy web authentifié vers l'IDE et l'extinction automatique sur inactivité. Elle est écartée comme socle initial pour une raison de forme, pas de qualité : le portail décrit ici porte une logique pédagogique, des devoirs, des listes d'extensions et un filtrage SEB, qui ne s'expriment pas naturellement en variables de template Terraform. Sur vingt postes, l'indirection coûte plus qu'elle ne rapporte. Elle redeviendra pertinente le jour où il faudra plusieurs hôtes, des quotas par groupe et un audit.

Eclipse Che répond au besoin en Kubernetes natif et gère le verrouillage d'extensions par ConfigMap, ce qui est exactement E5. Le coût d'exploitation d'un cluster pour vingt étudiants est disproportionné.

JupyterHub avec DockerSpawner et code-server est une base éprouvée en contexte pédagogique, avec authentification OIDC, cycle de vie par utilisateur et arrêt des sessions inactives. Le modèle mental reste centré notebook et l'extension vers la logique de devoir décrite ici demande autant de travail que le développement direct.

Gitpod n'a plus d'offre auto-hébergée communautaire. Kasm Workspaces réserve l'authentification unique aux éditions payantes.

### Ce qui est réutilisé

Safe Exam Browser, projet ouvert de l'EPF de Zurich, fournit le navigateur kiosque, le filtrage d'URL par configuration et surtout le mécanisme de preuve, Browser Exam Key et Config Key, que le portail doit vérifier. Il n'existe pas de version officielle pour Linux ; seules Windows, macOS et iOS sont publiées, ce qui contraint le parc de la salle d'examen.

SEB Server, composant officiel du même projet, centralise la configuration des clients pour un examen et permet la surveillance en temps réel des clients connectés. Il couvre une partie du volet enseignant et mérite une évaluation avant d'écrire cette partie du portail.

code-server ou openvscode-server fournissent le VS Code navigateur, construits sur la base ouverte de VS Code, donc dépourvus des composants propriétaires d'assistance au code.

### Position

Développement maison d'un portail mince, au-dessus de briques existantes, orchestrant directement des conteneurs. Le portail n'invente ni l'IDE, ni le navigateur d'examen, ni le moteur de conteneurs. Il apporte trois choses que rien ne fournit assemblées : la logique de devoir, la vérification SEB côté serveur, et un canal Git sans secret dans le conteneur.

## 7. Architecture cible

### Vue d'ensemble

Une machine virtuelle unique porte l'ensemble. Huit cœurs, trente-deux gigaoctets de mémoire vive et deux cents gigaoctets de stockage rapide absorbent vingt sessions de compilation C avec une marge confortable.

Sur cet hôte, cinq composants. Un frontal TLS, un service portail, un moteur de conteneurs, un jeu de volumes persistants, et un ensemble de miroirs de documentation servis en local. Le service portail est le seul code écrit pour ce projet.

### Le service portail

Il expose quatre surfaces distinctes, et cette séparation doit apparaître dans le code car les règles d'accès diffèrent.

Une interface étudiant et une interface enseignant, authentifiées par OpenID Connect.

Un proxy vers les conteneurs, qui relaie les requêtes HTTP et les websockets vers le code-server de la session, après vérification du jeton de session et, en mode examen, de la provenance SEB.

Un proxy Git, qui parle le protocole Git HTTP intelligent, authentifie par le jeton de session et relaie vers GitHub avec son propre jeton d'application. C'est la pièce non triviale de l'architecture, décrite plus bas.

Un orchestrateur, qui alloue, surveille et détruit les conteneurs, maintient un pool de conteneurs préchauffés et exécute le ramasse-miettes.

### Identité

Authentification par OpenID Connect contre le fournisseur institutionnel. Le portail conserve un identifiant stable et une adresse électronique, rien d'autre.

Rattachement GitHub par une application GitHub installée sur l'organisation, et non par une application OAuth simple. Cela donne d'une part l'identité de l'étudiant par le flux OAuth de cette même application, d'autre part des jetons d'installation à portée réduite et à durée de vie d'une heure, que le portail utilise pour parler aux dépôts sans jamais détenir de secret longue durée pour le compte de l'étudiant.

### Le canal Git, sans secret dans le conteneur

Le conteneur reçoit un dépôt déjà cloné, avec un remote pointant sur le portail, de la forme portail.acme.com/git/identifiant-de-session. Il ne détient ni clé SSH, ni jeton, ni credential helper persistant. L'authentification repose sur le jeton de session, injecté au démarrage dans la configuration Git du conteneur et révoqué à sa destruction.

Le portail implémente le protocole Git HTTP intelligent. Il autorise receive-pack, c'est-à-dire la poussée, et refuse upload-pack, c'est-à-dire le clonage et la récupération. Ce refus n'est pas une précaution cosmétique : il ferme la voie par laquelle un étudiant introduirait un fichier d'extension dans son environnement depuis l'extérieur.

Les bénéfices se cumulent. La liste blanche réseau du conteneur se réduit à une seule destination interne. Aucun secret n'est exfiltrable. Chaque poussée est journalisée avec horodatage, empreinte de commit et session, ce qui règle les litiges de rendu sans discussion.

### Conteneurisation et durcissement

Le choix entre Docker et Podman n'est pas tranché ; il figure en section 10. Dans les deux cas, le durcissement visé est le même.

Un espace de noms utilisateur distinct par conteneur, de sorte qu'une évasion atterrisse sur un identifiant sans privilège. Toutes les capacités retirées, à l'exception de CAP_SYS_PTRACE. Un profil seccomp dérivé du profil par défaut, autorisant l'appel système personality, faute de quoi gdb échouera à désactiver la randomisation d'espace d'adressage. Système de fichiers racine en lecture seule, tmpfs sur les répertoires temporaires, interdiction d'élévation de privilèges. Limite de processus à deux cent cinquante-six, limite mémoire à deux gigaoctets, limite processeur à un cœur.

Un seul réseau ponté dédié aux conteneurs, avec une politique nftables par défaut de rejet en sortie et deux autorisations : le port du proxy Git du portail, et le résolveur DNS interne à vues restreintes. Rien d'autre.

### Persistance

Un volume nommé par couple étudiant et devoir, indépendant du cycle de vie du conteneur. Le conteneur est du bétail, le travail ne l'est pas.

Une sauvegarde automatique périodique, de l'ordre de deux à trois minutes, sous forme de commit sur une branche de travail dédiée, distincte de la branche de rendu. Sans ce filet, la première séance d'examen produira un incident de perte de travail, et ce sera le seul dont l'établissement se souviendra.

### Le volet examen

Le portail génère, pour chaque devoir en mode examen, un fichier de configuration SEB chiffré contenant les règles de filtrage d'URL, l'URL de démarrage pointant sur la session, les réglages de kiosque, et la politique de téléchargement et de presse-papiers. Il conserve la Config Key associée ainsi que le Browser Exam Key de la version de SEB déployée.

Le lancement se fait par un lien de schéma sebs, que SEB reconnaît, ce qui lui fait récupérer la configuration et démarrer sans manipulation de fichier par l'étudiant.

La vérification côté serveur porte sur trois surfaces, et non sur la seule page d'accueil : la page de démarrage de session, l'appel qui crée le conteneur, et le proxy vers code-server. Vérifier uniquement la première laisse ouverte la copie de l'URL de session vers un navigateur ordinaire. En pratique, vérification stricte à l'ouverture, émission d'un cookie de session lié à cette vérification, et refus de toute requête du proxy dépourvue de ce cookie.

### Documentation hors ligne

Plutôt que d'autoriser des sites réels dans le filtre SEB, le portail sert des miroirs locaux sous ses propres chemins : une archive Kiwix pour l'encyclopédie, une instance DevDocs, une copie de la référence C et C++, les pages de manuel. La liste de filtrage SEB se réduit alors à une règle de domaine unique, ce qui supprime la question des réseaux de diffusion tiers et des domaines annexes que traîne tout site réel. Le contenu est identique pour tous et reproductible d'une session à l'autre.

## 8. Modèle de données

Quatre entités suffisent. Toute cinquième entité ajoutée dans la première version doit être justifiée.

User. Identifiant institutionnel, adresse électronique, rôle, login GitHub, identifiant numérique GitHub, date de rattachement.

Assignment. Intitulé, enseignant propriétaire, image de conteneur, liste blanche d'extensions, mode, fenêtre d'ouverture, modèle de dépôt ou convention de nommage, liste des destinations réseau autorisées pour le conteneur, liste de documentation autorisée pour SEB, blob de configuration SEB, Config Key, Browser Exam Key de référence.

Session. Étudiant, devoir, identifiant de conteneur, identifiant de volume, état, horodatage de création, dernier battement, jeton de session, indicateur de vérification SEB.

PushEvent. Session, horodatage, référence Git, empreinte de commit, résultat. Cette table est la seule preuve du rendu ; elle doit être écrite avant que le relais vers GitHub soit tenté, et complétée ensuite.

Une base relationnelle légère convient largement à cette échelle. Le choix du moteur est sans enjeu ; la seule contrainte réelle est que les états de session supportent une reprise après redémarrage du portail, c'est-à-dire que l'orchestrateur sache reconstruire son état à partir de la base et de l'inventaire des conteneurs vivants.

## 9. Modèle de menace

L'adversaire est un étudiant motivé, techniquement compétent, disposant de temps de préparation avant l'examen mais d'un temps limité pendant. Il n'est pas supposé disposer d'exploits sur des composants à jour. Il est supposé partager ses trouvailles avec sa promotion, donc toute faille découverte une fois est réputée connue de tous à la session suivante.

| Vecteur | Effet | Contre-mesure |
| --- | --- | --- |
| Ouvrir le portail hors SEB | Contournement total du mode examen | Vérification BEK et Config Key sur les trois surfaces, cookie lié à la vérification |
| Forger l'en-tête de preuve SEB | Idem | Le BEK ne doit jamais être exposé côté client ni transmis à l'étudiant |
| Modifier le fichier de configuration SEB | Filtre d'URL désactivé | Config Key dérivée des réglages, donc invalidée par toute modification ; chiffrement du fichier |
| Lire un secret Git dans le conteneur | Poussée depuis l'extérieur, exfiltration | Aucun secret dans le conteneur, jeton de session révoqué à la destruction |
| Récupérer un fichier d'extension par git pull | Contournement de la liste blanche d'extensions | upload-pack refusé par le proxy Git, clonage effectué au provisionnement |
| Installer une extension depuis la galerie | Idem | Champ de galerie retiré du product.json, réglage extensions.allowed, marketplace injoignable |
| Utiliser un navigateur interne à VS Code | Navigation hors filtre apparent | Les requêtes partent du navigateur, donc soumises au filtre SEB ; vérifier que les vues web sont servies sur l'origine du portail et non sur un réseau de diffusion tiers |
| Exfiltration par requêtes DNS | Canal de sortie déguisé | Résolveur interne à vues restreintes, pas de résolveur public accessible |
| Évasion de conteneur | Accès à l'hôte et aux autres sessions | Espace de noms utilisateur, capacités minimales, seccomp, racine en lecture seule ; option gVisor en mode examen |
| Épuisement de ressources, bombe à fork | Déni de service sur la classe entière | Limites de processus, de mémoire et de processeur par conteneur ; quota disque par volume |
| Second appareil, téléphone, voisin | Assistance externe | Hors périmètre technique, relève de la surveillance humaine |

### Les trois faiblesses structurelles à accepter

La vérification SEB repose sur un secret partagé entre le portail et le binaire SEB. Un étudiant qui obtient le Browser Exam Key peut forger les en-têtes depuis un navigateur ordinaire. La rotation de ce secret à chaque session d'examen, et sa non-exposition dans l'interface enseignant, sont donc des exigences opérationnelles et non des détails.

Le filtre d'URL de SEB n'existe que sur les plateformes où SEB existe, c'est-à-dire pas Linux en version officielle. Un parc de salle hétérogène affaiblit mécaniquement le dispositif.

Le terminal donne un interpréteur de commandes complet dans un conteneur. C'est le point d'entrée de toute évasion éventuelle, et il est irréductible puisque c'est précisément la fonctionnalité demandée. Le durcissement réduit la probabilité, il ne l'annule pas.

## 10. Décisions ouvertes

Ces arbitrages ne sont pas tranchés. Ce sont les points sur lesquels une analyse externe apporte le plus de valeur.

### D1. Docker ou Podman

Le mode sans privilège de Podman est le bon réflexe pour exécuter du code non fiable, mais il déplace la pile réseau en espace utilisateur, via pasta ou slirp4netns, ce qui invalide l'application des règles nftables telles qu'elles sont décrites en section 7. Le filtrage devient possible ailleurs, mais autrement.

Le compromis pressenti est un moteur avec privilèges, Docker ou Podman indifféremment, doté d'espaces de noms utilisateur automatiques, conservant une interface virtuelle classique et donc un filtrage nftables en amont sur le pont. Ce compromis doit être vérifié expérimentalement avant d'être retenu, car il conditionne E10.

Critère d'arbitrage : la capacité à démontrer, par test, qu'un processus dans le conteneur ne joint aucune destination hors liste blanche.

### D2. Isolation renforcée en mode examen

Faut-il basculer les conteneurs d'examen sur gVisor, voire sur une micro-machine virtuelle de type Firecracker, en conservant les conteneurs ordinaires pour les travaux pratiques ? Le surcoût est marginal à cette échelle et l'argument est solide face à un service juridique. La réserve porte sur gdb : la couverture de ptrace par gVisor est correcte mais pas identique, et doit être éprouvée avant engagement.

### D3. Provisionnement des dépôts

GitHub Classroom crée déjà les dépôts étudiants depuis un modèle et gère la correspondance entre identité étudiante et dépôt. Consommer cette correspondance plutôt que la réimplémenter économise une semaine de développement, au prix d'un couplage supplémentaire et d'une double interface pour l'enseignant. À arbitrer selon les usages existants de l'établissement.

### D4. Étendue de SEB Server

SEB Server couvre la configuration centralisée des clients et la surveillance en temps réel. Trois positions possibles : l'ignorer et tout faire dans le portail, l'utiliser comme générateur et distributeur de configurations en gardant le portail comme point d'entrée, ou en faire le point d'entrée de l'examen et réduire le portail à l'environnement de travail. La deuxième position semble la meilleure mais demande une évaluation de son interface programmatique.

### D5. Sémantique de la session simultanée

Que se passe-t-il si un étudiant ouvre un second onglet sur le même devoir ? Refuser est le plus simple et le plus sûr en examen. Reprendre la session existante est le plus confortable en travaux pratiques. Le comportement pourrait dépendre du mode, au prix d'une incohérence apparente.

### D6. Granularité du volume

Un volume par couple étudiant et devoir isole bien mais multiplie les objets et complique la sauvegarde. Un volume par étudiant, avec un répertoire par devoir, simplifie l'exploitation mais permet à l'étudiant de consulter pendant un examen le travail d'un autre devoir, ce qui peut être souhaitable ou non selon la pédagogie.

### D7. Ce que fait exactement la liste réseau de l'enseignant

Si la documentation est servie en miroir local, la liste des destinations réseau autorisées pour le conteneur n'a plus grand usage et pourrait disparaître de l'interface enseignant, remplacée par un simple choix d'image. Supprimer un réglage inutile vaut mieux que l'exposer et laisser croire qu'il protège quelque chose.

### D8. Langage et pile du portail

Aucune contrainte forte. Les seuls besoins particuliers sont un proxy websocket robuste, une implémentation ou une délégation du protocole Git HTTP intelligent, et un client du moteur de conteneurs. Ces trois besoins sont mieux servis par certaines piles que d'autres, ce qui devrait guider le choix davantage que les préférences d'équipe.

## 11. Stratégie de développement

### Principe directeur

Les risques de ce projet ne sont pas dans l'interface, ils sont dans trois hypothèses techniques non vérifiées. Tant qu'elles ne sont pas levées, tout développement d'interface est du travail potentiellement jeté. L'ordre des jalons découle entièrement de ce constat.

### Jalon 0 : lever les trois inconnues

Trois preuves, sans interface, en script et en ligne de commande.

Preuve A. code-server rendu correctement dans le navigateur embarqué de SEB, sur la plateforme de la salle, avec websockets, ouvriers de service et stockage local fonctionnels. Un échec ici invalide le choix d'IDE, pas le projet.

Preuve B. Vérification du Browser Exam Key et de la Config Key opérationnelle sur une route protégée, testée en tentant l'accès depuis un navigateur ordinaire, qui doit échouer.

Preuve C. Un conteneur qui pousse vers GitHub à travers le proxy Git, sans aucun secret en son sein, avec upload-pack refusé et le filtrage réseau actif.

Sans ces trois preuves, il n'y a pas de projet. Avec elles, le reste est de l'assemblage.

### Jalon 1 : squelette local complet

Le portail de bout en bout sur poste de développement, avec authentification simulée, un devoir codé en dur, un conteneur, un volume, le proxy IDE et le proxy Git. Pas d'interface enseignant, pas de mode examen, pas de pool. Objectif : un étudiant fictif démarre, écrit du code, compile, pousse.

### Jalon 2 : identité réelle

Branchement du fournisseur OpenID Connect institutionnel et de l'application GitHub. Remplacement du simulateur par les vrais flux, sans que le reste du code s'en aperçoive. Si ce remplacement demande de toucher autre chose que la couche d'authentification, c'est que le jalon 1 a mal isolé cette couche.

### Jalon 3 : mode examen

Génération des configurations SEB, gestion des clés, vérification sur les trois surfaces, filtrage d'URL, miroirs de documentation. C'est le jalon le plus risqué en exploitation et il doit être éprouvé en conditions réelles de salle, pas seulement en développement.

### Jalon 4 : interface enseignant

Création de devoirs, listes d'extensions, tableau des sessions actives. Volontairement tardif : tant que les enseignants ne sont pas dans la boucle, un fichier de configuration suffit, et les besoins réels de l'interface ne se révèlent qu'après une première séance vécue.

### Jalon 5 : exploitation

Pool de conteneurs préchauffés, ramasse-miettes, sauvegardes, supervision, procédures de secours. C'est ce qui transforme une démonstration en service.

### Séquencement et effort

Le jalon 0 se mesure en jours, pas en semaines, et conditionne tout le reste. Les jalons 1 et 2 forment le cœur technique. Les jalons 3 à 5 représentent environ la moitié de l'effort total, ce qui surprend systématiquement dans ce type de projet : les cas dégradés et l'exploitation pèsent autant que la fonctionnalité nominale.

Un pilote réaliste consiste à faire tourner une séance de travaux pratiques ordinaire avec un petit groupe volontaire après le jalon 2, bien avant tout usage en examen. L'examen doit être le dernier usage mis en production, jamais le premier.

## 12. Environnement de développement local

### Objectif

L'ensemble doit tourner sur un poste de développement, sans dépendance à une infrastructure institutionnelle, sans compte GitHub réel obligatoire, et sans SEB pour le développement courant. C'est la condition pour que le cycle de travail reste rapide et que plusieurs personnes puissent contribuer.

### Ce qui est simulé

L'authentification institutionnelle. Un fournisseur OpenID Connect factice, soit un serveur de test conforme au protocole, soit un adaptateur local qui émet les mêmes jetons. Le point essentiel est que le portail parle le vrai protocole même en local, avec découverte, échange de code et validation de jeton. Un raccourci du type variable d'environnement contenant un identifiant d'utilisateur donnerait un jalon 2 douloureux, parce que la couche d'authentification n'aurait jamais été exercée.

Un sélecteur d'utilisateur en développement permet de basculer entre un étudiant et un enseignant sans quitter le navigateur.

La destination Git. Une forge locale, Gitea ou Forgejo en conteneur, remplace GitHub. Le proxy Git relaie vers elle. Cela permet de tester le refus de upload-pack, la journalisation des poussées et la gestion des erreurs sans dépendre d'un réseau ni d'un quota d'interface programmatique.

### Ce qui ne doit surtout pas être simulé

Le filtrage réseau. Il doit être actif dès le premier jour, sur le poste de développement, faute de quoi le projet découvrira en préproduction que la configuration de conteneur retenue le rend inapplicable. C'est l'inconnue D1, et le seul moyen de la lever est de la vivre en continu.

Le durcissement du conteneur. Les capacités, seccomp, les limites et la racine en lecture seule doivent être posés dès le jalon 1. Les ajouter ensuite revient à découvrir tardivement que gdb ne fonctionne plus, ou que le serveur de langage manque de mémoire.

Le proxy Git. Il porte une exigence de sécurité centrale ; un raccourci local qui poserait une clé dans le conteneur pour aller plus vite créerait une architecture parallèle qu'il faudrait défaire.

Le protocole d'authentification, comme indiqué plus haut.

### Forme attendue

Un fichier de composition pour l'environnement de développement, portant le portail, le fournisseur d'identité factice, la forge locale et les miroirs de documentation. Le moteur de conteneurs de l'hôte est utilisé directement par le portail pour les conteneurs étudiants, qui ne font pas partie de la composition puisqu'ils sont créés dynamiquement.

Un jeu de données d'amorçage : deux étudiants, un enseignant, un devoir en mode travaux pratiques, un devoir en mode examen, un dépôt de départ dans la forge locale.

### Traitement du mode examen en local

SEB ne sera pas installé sur chaque poste de développement. La vérification doit néanmoins être développée et testée. La forme retenue est une double implémentation de la vérification, l'une réelle et l'une simulée, sélectionnée par configuration, avec un jeu de tests automatisés qui couvre les deux et surtout les cas de refus. Le test manuel avec un vrai SEB reste obligatoire avant le jalon 3, sur une machine dédiée, mais ne conditionne pas le développement quotidien.

## 13. Risques, succès, questions pour l'analyse

### Risques principaux

Incompatibilité de code-server avec le navigateur embarqué de SEB. Probabilité moyenne, impact élevé : impose de changer d'IDE navigateur. Traité par le jalon 0.

Filtrage réseau inapplicable dans la configuration de conteneur retenue. Probabilité moyenne, impact élevé : remet en cause D1 et potentiellement le choix de moteur. Traité par le jalon 0 et par l'interdiction de simuler cette couche en local.

Absence de SEB officiel sous Linux contraignant le parc de salle. Probabilité certaine, impact variable selon l'établissement. À instruire avant tout engagement sur le mode examen.

Perte de travail d'un étudiant pendant un examen. Probabilité faible si le filet de sauvegarde est en place, impact institutionnel majeur. C'est le risque qui justifie à lui seul la sauvegarde automatique périodique et le volume découplé du conteneur.

Mise à jour de VS Code cassant le verrouillage d'extensions ou la modification du product.json. Probabilité élevée sur la durée. Traité par le gel de la version d'image et une recette avant chaque période d'examen.

Dérive de périmètre vers un système de gestion de cours. Probabilité élevée dès que les enseignants découvrent l'outil. Traité par la section 4.

### Critères de succès

Une séance de travaux pratiques de deux heures avec vingt étudiants sans intervention technique.

Temps entre le clic de démarrage et un éditeur utilisable inférieur à dix secondes en perception.

Aucune perte de travail sur une session complète, y compris en simulant des coupures.

Une tentative documentée d'accès hors SEB qui échoue.

Un enseignant crée un devoir de bout en bout sans assistance.

### Questions adressées à l'analyse

L'architecture du canal Git sans secret est-elle la bonne réponse à la tension entre E9 et E10, ou existe-t-il une approche plus simple offrant les mêmes garanties ?

Le refus de upload-pack est-il tenable en pratique pédagogique, sachant qu'il empêche l'étudiant de récupérer une correction ou une mise à jour d'énoncé en cours de séance ? Quelle alternative préserverait la garantie ?

Le choix de ne pas partir de Coder est-il justifié à cette échelle, ou le coût de l'orchestration maison est-il sous-estimé ?

Le découpage en jalons place l'interface enseignant en position tardive. Est-ce soutenable du point de vue de l'adhésion des utilisateurs, ou faut-il une maquette non fonctionnelle plus tôt ?

Quels angles morts ne figurent pas dans ce document ? Les candidats attendus concernent l'accessibilité, la conformité au traitement des données personnelles des étudiants, la conservation des traces de session et sa durée, et les obligations en matière d'aménagements d'examen.
