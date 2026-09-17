# Pistes et options notées en cours de route

Notes du 2026-09-17, à trier au fil des jalons. Rien ici n'est engagé ; ce sont les arbitrages discutés après le jalon 0 pour ne pas les perdre.

## Hébergement

Dimensionnement pour vingt sessions : 8 vCPU, 16 Go, 80 Go suffisent (mesuré : quelques centaines de Mo par session au repos, rafales CPU à la compilation). Les 32 Go du cadrage sont une marge.

Prix mensuels hors TVA relevés le 2026-09-17 (Hetzner a relevé ses tarifs le 15 juin 2026, jusqu'à ×2,7 sur CPX/CCX) :

| Offre | vCPU | RAM | Prix |
| --- | --- | --- | --- |
| Hetzner CX43, partagé | 8 | 16 Go | €15,99 |
| Hetzner CX53, partagé | 16 | 32 Go | €29,49 |
| Hetzner CCX33, dédié | 8 | 32 Go | €138,49 |
| DigitalOcean Basic | 8 | 16 Go | $96 |
| AWS / Azure 8 vCPU à la demande | 8 | 32 Go | ≈ $0,40 à 0,55 l'heure + disque |

Position : une VM Hetzner partagée toujours allumée pour les TP ; pour les examens, une machine dédiée créée par API la veille et détruite le soir (≈ €2 la journée) plutôt qu'une dédiée dormante. L'orchestration « démarrer la VM à la demande » ne devient rentable que sous quelques dizaines d'heures d'usage par mois et coûte un vrai développement (jalon 5).

À vérifier avant décision : crédits Azure de l'accord institutionnel HEIG-VD (Azure Switzerland North et AWS Zurich règlent aussi la résidence des données en Suisse). Ni Hetzner ni DigitalOcean n'ont de région suisse ; Infomaniak et Exoscale non chiffrés.

## Intégration dans heig-classroom (décidé)

Le portail déménage dans le monorepo heig-classroom comme seconde application (`apps/codespace`), par `git subtree` pour garder l'historique, au jalon 2. Règle d'import : `apps/codespace` n'importe que les paquets partagés (`packages/contracts`, `packages/domain`, plus tard l'UI), jamais `apps/server`. Déploiements séparés : classroom sur sa petite VM, le moteur de conteneurs sur une VM dédiée, liaison par jeton de lancement signé.

Côté classroom :
- un devoir gagne un mode de travail : libre (flux actuel), en ligne (sessions dans le portail, push relayé par la GitHub App), en ligne sous SEB (vérification SEB exigée) ;
- en mode en ligne, le dépôt étudiant est créé **sans droit d'écriture** pour l'étudiant : aucun credential étudiant à gérer, le relais pousse avec le jeton d'installation, le CI de notation se déclenche normalement ;
- le bouton Démarrer est sur l'interface classroom, une seule interface pour l'étudiant ;
- la fonctionnalité est **activée par l'administrateur, enseignant par enseignant**, avec un quota de sessions actives par enseignant et un quota global. Les enseignants non habilités ne voient pas l'option. Cela permet un pilote à un ou deux étudiants sans toucher aux autres écoles.

Terme d'interface à choisir : « codespace » entre en collision avec GitHub Codespaces ; « environnement en ligne » ou « atelier » sont candidats.

## Fonctionnalités discutées, ordre proposé

1. **Profil étudiant** : réglages utilisateur de VS Code (thème, police, raccourcis) persistés par étudiant sur l'hôte et montés dans le conteneur ; en mode examen, seule une liste blanche de clés est recopiée (les snippets et le texte libre des réglages sont un canal d'antisèche). Pas d'écran de préférences dans le portail.
2. **Boutons de session** sur la page d'accueil : revenir à l'éditeur, terminer (arrêt du conteneur, volume conservé). En examen, une route « rendre et quitter » qui vérifie le relais du dernier push puis redirige vers l'URL de sortie de SEB.
3. **Catalogue d'images** : `vi`, `perl`, `hexdump`, `xxd` vont dans l'image de base ; Python, uv, Typst dans des images dérivées par `FROM`, construites par CI, choisies par nom dans le devoir. Écarté : groupes d'outils composables (construction par devoir), fichier `.codespace` dans le dépôt étudiant (l'étudiant choisirait son image en mode TP ; s'il existe un jour, lu dans le dépôt modèle seulement), Containerfile soumis par formulaire (construction arbitraire en root sur l'hôte).
4. **Extension de barre d'état** VS Code (portail / rendre) : après la première répétition d'examen en salle.
5. **Ligne graphique** : découle du monorepo (composants React partagés au jalon 4) ; en attendant, copier les variables CSS de classroom dans les pages HTML.

## Retours du premier essai réel (2026-09-17, classroom de test)

Session ouverte depuis classroom par un vrai compte, VS Code servi, push relayé vers GitHub par la GitHub App. Trois retours d'interface, tous à traiter dans l'image (réglages machine et extension), pas dans le portail :

1. **Barre latérale secondaire vide** ouverte par défaut (elle hébergeait le chat, désactivé) : à masquer au démarrage par réglage machine ; nom exact du réglage à vérifier dans la version 1.137 embarquée.
2. **Disposition clavier détectée « Swiss German »** : VS Code Web n'a pas de disposition suisse romande. La frappe n'est pas affectée, seuls certains raccourcis le sont ; poser `keyboard.dispatch: keyCode` dans l'image.
3. **Extension de barre d'état** (déjà en piste 4 ci-dessus, désormais prioritaire) : compte à rebours jusqu'à l'échéance du devoir et bouton « Fermer » qui ramène vers classroom. Le portail transmet l'échéance et l'URL de retour au conteneur au démarrage (variables d'environnement ou fichier de réglages machine) ; l'extension est cuite dans l'image et dans la liste blanche.

### Traités le 2026-09-18 (branche `feat/codespace-image-ux`)

Les trois points ci-dessus sont faits. Détail, preuves et limites dans
[images/c-dev/README.md](../images/c-dev/README.md).

1. **Fait.** `workbench.secondarySideBar.defaultVisibility: "hidden"` dans les réglages machine. Le nom, l'énumération et le défaut amont (`visibleInWorkspace`) ont été relevés par `grep` dans le paquet VS Code 1.137.0 embarqué ; `test.sh` § 7 rejoue la recherche. Effet visuel à constater au navigateur : `TODO(verify)`.
2. **Fait.** `keyboard.dispatch: "keyCode"`, même méthode de vérification (`enum:["code","keyCode"]`, défaut `code`). La frappe n'est pas affectée, c'est noté dans le README de l'image. Réserve relevée et notée `TODO(verify)` : la déclaration porte `included: jo===2||jo===3`, donc la clé n'est enregistrée que pour macOS et Linux — à vérifier sur un poste Windows, qui est la plateforme de la salle.
3. **Fait.** Extension `heig.codespace-statusbar` 0.1.0, JavaScript pur, empaquetée en `.vsix` par une étape multi-stage (`node:22-slim` + `@vscode/vsce` 4.0.0) puis installée comme les deux autres extensions, donc listée par `--list-extensions` et ajoutée à `extensions.allowed`. Le portail pose trois variables au `podman run` — `CODESPACE_DEADLINE` (l'échéance du devoir), `CODESPACE_RETURN_URL` (classroom si la session vient d'un jeton de lancement, le portail sinon), `CODESPACE_ASSIGNMENT_NAME` — et **rien d'autre** : un test unitaire et `test.sh` § 9 l'affirment, invariant 1 oblige.

Ce que cela ne règle pas, et qui reste en piste 2 ci-dessus : « Fermer » ouvre
un onglet vers l'URL de retour, il ne termine pas la session. Une vraie route
« terminer » (arrêt du conteneur, volume conservé) reste à écrire côté portail.

## Correction au cadrage relevée par le test SEB

Le filtre d'URL de SEB doit autoriser le domaine du fournisseur d'identité (Switch edu-ID) en plus de celui du portail, sinon la page de connexion est bloquée. Le cadrage parlait d'une règle de domaine unique.
