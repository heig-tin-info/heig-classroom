# Développement

Cette section est la mémoire d'ingénierie de HEIG Classroom. Le projet est
développé principalement par Claude, l'agent de programmation d'Anthropic, qui
travaille à partir de ces documents : ils ne sont pas un supplément après coup
mais bien la source de vérité qui guide l'implémentation. Si vous contribuez,
humain ou IA, commencez ici.

La méthode est délibérément à l'ancienne : les exigences d'abord, puis les
spécifications, puis l'architecture, puis le code. Chaque exigence porte un
identifiant stable (US-xx pour les user stories, NFR-xx pour les exigences non
fonctionnelles, AU/GH/GR-xx pour les spécifications fonctionnelles) et le code
référence ces identifiants dans les commentaires et les messages de commit.
Lorsqu'une décision change, le document est révisé en premier, puis le code
suit.

Ce que vous trouverez ici, dans l'ordre de lecture :

1. **Analyse des besoins** : l'idée initiale, les acteurs, le modèle du
   domaine, les risques et les décisions qui ont façonné tout le reste.
2. **Cahier des charges** : les user stories avec leurs critères
   d'acceptation, les exigences non fonctionnelles, les contraintes et les
   hypothèses validées (H1 à H12, avec leurs révisions).
3. **Spécifications fonctionnelles** : le comportement précis de chaque
   sous-système, de la connexion Switch edu-ID à la collecte des notes.
4. **Architecture** : la conception consolidée, un monolithe Fastify au-dessus
   de PostgreSQL pilotant GitHub par l'intermédiaire d'une GitHub App, ainsi
   que treize décisions d'architecture sous `docs/adr/` dans le dépôt.
5. **Études préliminaires** : ce qui a réellement été mesuré face à l'API
   GitHub réelle avant de s'engager sur une conception, y compris les pièges
   découverts en chemin (nouvelle tentative d'Octokit sur les dépôts vides,
   `safe.bareRepository`, et consorts).

Tout, dans le dépôt, est écrit en anglais — code, commentaires, documentation
et messages de commit ; seule l'interface destinée à l'utilisateur final suit la
langue de celui-ci (le portail est livré en anglais et en français). Les
documents de spécification sont composés avec
[TeXSmith](https://github.com/heig-tin-info/texsmith) ; chacun se construit en
PDF avec `texsmith docs/<doc>.md --build`.
