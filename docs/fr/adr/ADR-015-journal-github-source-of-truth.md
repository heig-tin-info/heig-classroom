# ADR-015 — Le journal de classe : GitHub détient le contenu, PostgreSQL un modèle de lecture

## Statut

Acceptée (2026-09-27, issue #45). Lecture, écriture et ingestion implémentées le
jour même ; la surface d'édition WYSIWYG est reportée, voir « Conséquences ».

## Contexte

Une classe a besoin d'un endroit pour son support de cours — notes de cours,
exemples de code, figures, formules, documents à distribuer. Jusqu'ici le seul
contenu qu'une classe portait était ses devoirs, si bien que tout le reste vivait
hors de la plateforme et que les étudiants avaient deux adresses pour un cours.

La plateforme stocke déjà beaucoup de choses *à propos* des dépôts : leur état de
provisionnement, leur commit de tête, leurs notes. Le journal est la première fois
qu'elle stockerait du **contenu**, et cela pose une question que le reste du
produit n'a jamais eu à trancher : où vit réellement une page ?

Deux enseignants étaient dans la pièce, et ce n'est pas la même personne :

- celui qui veut un éditeur à la Notion et se moque qu'il y ait un dépôt git
  en dessous ;
- celui qui préfère cloner la chose, écrire dans son propre éditeur, et pousser.

Ne servir que le premier, c'est ce que fait Moodle, et cela enferme le support
dans la plateforme. Ne servir que le second, c'est un générateur de site statique,
vers lequel il faudrait envoyer les étudiants. Servir les deux depuis deux modèles
de contenu, ce serait deux sources de vérité et un problème de fusion.

## Décision

**Le journal est un dépôt GitHub privé de l'organisation de la classe. GitHub fait
foi pour le contenu ; PostgreSQL détient un modèle de lecture rendu, reconstruit
depuis un push ou depuis un enregistrement dans le navigateur.**

1. **Le dépôt est le contenu.** Un fichier markdown par page, la structure même du
   dépôt fait la navigation (à la manière de MkDocs : ordre alphabétique, préfixes
   numériques pour le contrôler, `README.md` comme page d'accueil d'un répertoire).
   Pas de fichier manifeste, pas d'enregistrements de cellules, pas d'identifiants
   injectés dans le markdown — un fichier qu'un humain édite dans `vim` doit rester
   un fichier qu'un humain édite dans `vim`.
2. **PostgreSQL est un modèle de lecture, jamais ce qu'un enseignant édite.**
   `journal_pages` contient le markdown, le HTML rendu, la table des matières et le
   sha du blob dont il a été rendu. L'affichage d'une page est un `SELECT` et jamais
   un appel à GitHub, ce qui rend la fonctionnalité abordable sur une VM 1 vCPU /
   2 Go partagée avec la base de production.
3. **Le rendu a lieu une fois, à l'ingestion, sur le serveur.** Le chemin de lecture
   n'embarque aucune bibliothèque markdown. Le HTML brut présent dans le markdown est
   **échappé en texte visible** plutôt qu'assaini, de sorte que la sortie est sûre par
   construction et que l'image n'a besoin d'aucun assainisseur fondé sur un DOM.
4. **Rien n'est cloné côté serveur.** Uniquement les API Contents et Trees. Le
   provisionnement des devoirs appelle `git` dans un répertoire temporaire, ce qui est
   juste pour pousser un historique ; un journal n'a besoin que de fichiers isolés et
   d'une lecture d'arborescence.
5. **Les écritures vont d'abord à GitHub, avec un verrou optimiste.** Le sha du blob
   avec lequel l'éditeur a ouvert la page accompagne l'enregistrement ; GitHub répond
   409 si quelqu'un a poussé entre-temps. La plateforme ne compare jamais les contenus
   et ne fusionne jamais : le perdant de la course en est informé, et son brouillon est
   conservé dans son navigateur.
6. **La création n'adopte jamais un dépôt existant.** `provisionStudentRepo` traite un
   422 comme « étape déjà faite » et adopte, ce qui est juste pour un dépôt dont il est
   le seul rédacteur. Ici, cela donnerait à une classe le support qui se trouvait sous
   ce nom. Rattacher un dépôt existant est une action distincte et délibérée — et c'est
   aussi ainsi qu'un journal sert plusieurs classes.
7. **Un miroir par couple (dépôt, ref).** Deux classes qui partagent un journal
   partagent la ligne ; une classe épinglée sur la branche du semestre passé obtient sa
   propre ligne sur le même dépôt.

## Alternatives rejetées

- **Le contenu dans PostgreSQL, avec un export vers un dépôt plus tard.** Moins cher à
  écrire, et faux à terme : greffer après coup « git fait foi » sur « la base fait foi »
  signifie deux sources de vérité et une sémantique de conflit inventée a posteriori. Si
  git est la destination, y aller d'emblée est le chemin le moins cher.
- **Des cellules identifiées, à la Notion, sérialisées en markdown.** Les « cellules » de
  la demande sont une affordance d'*édition*, et un éditeur les fournit sans les
  persister. Les sérialiser signifierait des marqueurs `<!-- cell:a3f -->` tout au long du
  fichier : illisibles dans le dépôt et détruits à la première édition manuelle.
- **Le rendu à la lecture, côté client.** Cela mettrait un analyseur markdown, KaTeX et un
  assainisseur dans le bundle de chaque étudiant, et referait le rendu de la même page à
  chaque affichage. Le rendu à l'ingestion coûte le même travail une fois par push.
- **Cloner le dépôt pour le rendre.** Du disque et un processus git par classe sur une VM
  qui n'a ni l'un ni l'autre à revendre.

## Conséquences

- Une panne de GitHub dégrade le journal en **lecture seule** au lieu de le casser : le
  miroir répond à toutes les lectures.
- Le pipeline de rendu est une **deuxième implémentation markdown** dans l'organisation, à
  côté de celle de `~/heig-quiz`. Les parties pures sont partagées par copie
  (`codeHighlight.ts` est repris dans `packages/domain`), le reste ne l'est pas. C'est
  accepté, avec la jointure nommée : le composant d'édition prend `value` / `onChange` /
  `onUploadImage`, ce qui est exactement la forme de la surface Tiptap du quiz. Reprendre
  cette surface exige de la découpler *là-bas* d'abord, dans un autre dépôt ; ce
  changement livre donc l'éditeur de source plus un aperçu rendu par le serveur, et laisse
  la surface WYSIWYG à une suite.
- Réordonner une page est un **renommage**, puisque l'ordre vit dans les noms de fichiers.
  Des pas de dix le rendent rare ; le cas échéant, l'API Trees l'applique en un seul
  commit.
- Un dépôt est un mauvais magasin de binaires : chaque révision d'une image y reste pour
  toujours. Les fichiers joints sont plafonnés à 5 Mo, et seuls ceux qu'une page référence
  réellement sont téléchargés et mis en cache.
- L'équipe enseignante doit être collaboratrice du dépôt du journal pour que le chemin
  expert fonctionne. La plateforme l'invite ; les étudiants ne le sont jamais — le dépôt
  est privé et la plateforme en est le seul lecteur.
