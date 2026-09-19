# Maquette de l'interface et captures d'écran

Comment regarder chaque écran d'`apps/web` sans backend, et comment capturer ce
que l'on a regardé. Le contrat visuel lui-même vit dans `apps/web/DESIGN.md` ;
les règles de travail d'une modification de l'interface vivent dans
`.claude/skills/hgc-ui/SKILL.md`.

## Lancer la maquette

```bash
pnpm --filter @hgc/web dev:mock      # http://localhost:5173
```

`src/mock/index.ts` remplace `window.fetch` et `EventSource` par un portail en
mémoire : chaque point d'accès appelé par l'application est servi à partir de
fixtures, et les mutations modifient ces fixtures pour que les flux paraissent
réels. Un rechargement repart de zéro. Le module est importé derrière
`import.meta.env.VITE_MOCK`, si bien qu'un build de production l'abandonne.

## Indicateurs d'URL

Les indicateurs sont lus dans la chaîne de requête, mémorisés dans
`localStorage` puis retirés de l'URL, exactement comme le persona. Ajoutez `=0`
pour en effacer un (`?many=0`), et lisez la ligne de console au démarrage pour
voir lesquels sont actifs.

| Indicateur | Effet |
| --- | --- |
| `?as=teacher\|student\|admin` | Persona de la session. |
| `?unlinked=1` | Étudiant sans compte GitHub lié. |
| `?empty=1` | Rien nulle part : aucune classe, aucune liste des étudiants, aucun devoir, aucun enseignant, aucune tâche planifiée. Les classes restent adressables par URL, si bien que `/classrooms/c1` montre une liste des étudiants vide et une liste de devoirs vide. |
| `?fail=1` | Chaque GET sous `/app/api` répond 500 `{"message":"Simulated failure"}`, sauf `/app/api/me` pour que la coque continue de s'afficher. L'état d'erreur apparaît après environ une seconde : React Query réessaie une fois (jamais sur un 4xx) avant d'abandonner. |
| `?slow=1` | 2,5 s de latence sur chaque appel : les squelettes et les indicateurs de chargement restent à l'écran. |
| `?many=1` | 30 classes, une liste de 120 étudiants et 40 devoirs sur la première : longues listes, longs tableaux et barre latérale sous charge. |

Classes fixes à connaître :

| Chemin | État |
| --- | --- |
| `/classrooms/c1` | Tout est nominal : GitHub App installée, plan Team, cinq devoirs couvrant brouillon, publié, verrouillé, en ligne et à durée. |
| `/classrooms/c2` | Installée mais sur le plan GitHub Free, et `ANTHROPIC_API_KEY` absente : deux bandeaux d'avertissement, plus un devoir d'examen SEB. |
| `/classrooms/c3` | Classe co-enseignée (`isOwner: false`) : les actions réservées au propriétaire ont disparu. |
| `/classrooms/c4` | GitHub App **non installée** : l'assistant d'installation remplace les devoirs. |
| `/classrooms/c5` | Organisation **absente** sur GitHub (`exists: false`) : le bandeau d'échec en lecture seule. |

## Captures d'écran

```bash
pnpm --filter @hgc/web dev:mock                    # terminal 1
pnpm --filter @hgc/web screenshots                 # terminal 2
```

`apps/web/scripts/screenshots.mjs` pilote Chromium par `playwright-core` (une
devDependency d'`@hgc/web`). C'est un outil de développement : rien ne
l'importe, il ne fait pas partie du build et il ne tourne pas en CI.

| Indicateur | Effet |
| --- | --- |
| `--list` | Affiche les noms des scènes et quitte. |
| `--only=<sous-chaîne>` | Garde les scènes dont le nom la contient ; répétable. Un mot nu fonctionne aussi. |
| `--width=390` | Largeur de la fenêtre ; répétable (`--width=390 --width=768 --width=1440`). 1440 par défaut. |
| `--dark` | Thème sombre (pose `hgc-theme` et le schéma de couleurs du système). |
| `--fold` | La fenêtre seulement, au lieu de la page entière. |

`BASE` (`http://localhost:5173` par défaut) et `OUT` (`apps/web/screenshots/`
par défaut, ignoré par git) sont des variables d'environnement. Les fichiers
sont nommés `<scène><-dark><-largeur>.png`, si bien qu'une capture claire en
1440 est simplement `<scène>.png`.

Une scène est une entrée du tableau `scenes` : un persona, une URL (indicateurs
de maquette compris), des entrées `localStorage` facultatives et un `act`
facultatif qui ouvre un panneau, un menu ou une boîte de dialogue avant la
capture. Ajouter un état à regarder revient à y ajouter une ligne. Le lanceur
signale toute erreur de console ou de page à côté du fichier qu'il a écrit, ce
qui est le contrôle de régression le moins coûteux que possède l'application.

Puis **lisez les PNG**. Une modification qui n'a pas été regardée n'est pas
terminée.
