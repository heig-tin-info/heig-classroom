# Preuve B, partie manuelle : un vrai Safe Exam Browser

La partie automatisée de la preuve B est dans
[`src/seb/`](../src/seb/README.md) : elle prouve que le
portail calcule la même Config Key que l'implémentation de référence et qu'il
refuse tout ce qui n'est pas une requête SEB valide. Elle ne peut pas prouver
qu'un **vrai** SEB accepte la configuration générée et envoie les en-têtes
attendus : aucun binaire SEB ne tourne sur Linux.

Cette procédure comble ce trou. Elle demande une trentaine de minutes, un poste
Windows ou macOS, et une seule exécution par version de SEB déployée en salle.

Elle lève aussi les `TODO(verify)` listés dans le README du module : profitez-en
pour noter ce que SEB fait réellement de `browserViewMode`, de `browserURLSalt`
et d'un `browserExamKey` vide.

## 0. Ce qu'il faut avant de commencer

- Le portail joignable depuis le poste de test **sur son URL publique en
  HTTPS**, celle qui sera utilisée en salle. Pas `localhost`, pas une adresse
  IP : la Config Key et le hachage de requête portent sur l'URL absolue, et un
  `sebs://` sur `localhost` ne prouve rien de l'installation réelle.
- Safe Exam Browser installé sur le poste, dans la version exacte du parc.
  <https://safeexambrowser.org/download_en.html>
- L'outil de configuration : sur Windows, **SEB Configuration Tool**, installé
  avec SEB ; sur macOS, **SEB → Préférences**, fenêtre qu'il faut avoir
  autorisée (`allowPreferencesWindow`) — ce que la configuration d'examen
  interdit, d'où l'étape 2 qui ouvre le fichier dans l'outil et **non** dans
  SEB en mode examen.
- Un devoir en mode examen dans `seed/assignments.yaml`, avec une liste de BEK
  **vide** pour l'instant.
- Le portail en `SEB_VERIFIER=real`. En `simulated`, tout passe et la preuve ne
  vaut rien.

## 1. Récupérer le fichier de configuration du devoir

Depuis un navigateur ordinaire du poste de test :

```
https://<portail>/exam/<devoir>.seb
```

Le portail répond en `application/seb`, nom `config.seb`. Enregistrez le fichier
sans l'ouvrir. Vérifiez, dans un éditeur de texte, qu'il commence par
`<?xml version="1.0"` : un `.seb` non chiffré est du plist XML nu.

Vérifiez aussi qu'il ne contient **aucun** Browser Exam Key : le champ
`browserExamKey` doit être une chaîne vide. Si vous y trouvez une clé, arrêtez :
le secret partagé est en train d'être remis à l'étudiant.

## 2. Lire le Browser Exam Key dans l'outil de configuration

> **Ne ré-enregistrez pas le fichier.** C'est le piège principal. Ouvrir la
> configuration dans l'outil et cliquer « Enregistrer » régénère `examKeySalt`,
> ce qui change la Config Key *et* tous les BEK des autres plateformes. Vous
> devriez alors tout recommencer sur chaque poste.

**Windows.** Lancez *SEB Configuration Tool*, `Fichier → Ouvrir`, choisissez le
`config.seb` téléchargé. Onglet **Exam**. Le champ **Browser Exam Key** affiche
une chaîne de 64 caractères hexadécimaux. Copiez-la. L'onglet affiche aussi la
**Config Key** : comparez-la à celle que le portail a enregistrée pour le
devoir. Si les deux diffèrent, tout le reste échouera ; c'est le signe que la
normalisation ou la génération du fichier diverge — notez la valeur affichée et
ouvrez un ticket avant de continuer.

**macOS.** Lancez SEB, `SEB → Préférences`, `Fichier → Ouvrir les réglages`,
choisissez le même `config.seb`. Onglet **Exam**, même champ **Browser Exam
Key**. Copiez-la.

**Le BEK diffère par plateforme et par version.** C'est sa raison d'être : il
atteste du binaire autant que de la configuration. Un BEK lu sur Windows ne
vaudra pas sur macOS, et un BEK lu sur la version 3.7 ne vaudra pas sur la 3.8.
Recommencez l'étape 2 sur **chaque** couple (plateforme, version) du parc, à
partir du **même** fichier téléchargé, sans jamais l'enregistrer.

## 3. Enregistrer les BEK dans le devoir

Dans `seed/assignments.yaml`, sur le devoir concerné :

```yaml
  beks:
    - "…64 caractères, poste Windows 3.8…"
    - "…64 caractères, poste macOS 3.4…"
```

C'est une **liste**, une entrée par couple (plateforme, version) : analyse.md
§ 4.4. Redémarrez le portail.

Le BEK est un secret partagé : il ne va pas dans un dépôt public, il n'apparaît
pas dans l'interface enseignant, il ne va pas dans les journaux (un test
l'affirme), et il se change à chaque session d'examen (project.md § 9).

## 4. Le chemin nominal : ouvrir le lien `sebs://`

Depuis un navigateur ordinaire du poste, ouvrez la page du devoir et cliquez le
lien :

```
sebs://<portail>/exam/<devoir>.seb
```

Attendu, dans l'ordre :

1. le navigateur demande à ouvrir Safe Exam Browser ; acceptez ;
2. SEB démarre, passe en mode kiosque, télécharge la configuration ;
3. SEB ouvre `startURL`, c'est-à-dire `https://<portail>/exam/<devoir>/start` ;
4. le portail vérifie les deux en-têtes, pose le cookie `exam_session` et
   redirige vers `/s/<session>/` ;
5. **l'éditeur code-server s'affiche**, et le terminal fonctionne.

Notez ici ce que vous observez sur les `TODO(verify)` : SEB est-il en plein
écran (`browserViewMode: 1`) ? La barre d'outils du navigateur est-elle
masquée ? Le presse-papiers est-il isolé ?

**Si l'étape 4 échoue en 403**, la cause est presque toujours l'une de trois :

- **URL reconstruite à tort derrière le frontal.** Le portail a haché
  `http://127.0.0.1:3000/exam/…` là où SEB a haché
  `https://<portail>/exam/…`. Corrigez en fixant `publicOrigin` sur l'origine
  publique du portail plutôt qu'en faisant confiance à `Host`. La journalisation
  du refus imprime l'URL retenue : comparez-la à ce que la barre d'adresse de
  SEB montre.
- **Config Key différente.** Le fichier a été ré-enregistré entre l'étape 1 et
  l'étape 4, ou le devoir a été modifié depuis. Retéléchargez, recommencez à
  l'étape 2.
- **BEK d'une autre version.** Le poste n'a pas la version pour laquelle le BEK
  a été lu. La raison journalisée est `browser-exam-key-mismatch`.

Vérifiez dans les journaux du portail qu'aucun BEK, ni aucun haché reçu,
n'apparaît, y compris sur les refus.

## 5. Le chemin qu'il faut casser : copier l'URL dans Edge

C'est la preuve que le dispositif tient. Dans SEB, notez l'URL de session
affichée à l'étape 4 — de la forme `https://<portail>/s/<session>/`.

Quittez SEB (`quitURL`, ou le bouton de sortie si `allowQuit` le permet).

Ouvrez **Microsoft Edge** — ou n'importe quel navigateur ordinaire — et collez
l'URL de session.

**Attendu : 403 et la page « Session hors Safe Exam Browser ».** Edge n'a pas le
cookie `exam_session` : il n'est jamais passé par la route de démarrage.

Trois variantes à vérifier, toutes doivent donner 403 :

| Variante | Manipulation | Raison journalisée attendue |
| --- | --- | --- |
| Sans cookie | coller l'URL de session dans Edge | `missing` |
| URL de démarrage directe | coller `https://<portail>/exam/<devoir>/start` dans Edge | `missing-config-key-header` |
| Cookie volé | recopier le cookie `exam_session` du poste SEB vers un **autre poste** (autre adresse IP) et rouvrir l'URL de session | `address-mismatch` |

La troisième variante est celle qui compte le plus : elle prouve la liaison à
l'adresse client (analyse.md D5). Sur un même poste, le cookie fonctionnera,
ce qui est voulu — un second onglet reprend la session.

## 6. Ce que cette procédure ne prouve pas

- Elle ne prouve rien contre un étudiant qui **obtient le BEK**. project.md § 9
  l'assume : « un étudiant qui obtient le Browser Exam Key peut forger les
  en-têtes depuis un navigateur ordinaire ». D'où la rotation à chaque session.
- Elle ne prouve rien sur Linux : SEB n'y existe pas en version officielle.
  Un parc de salle hétérogène affaiblit mécaniquement le dispositif.
- Elle ne dit rien du second appareil ni du voisin. Cela relève de la
  surveillance humaine.

## 7. Trace

Reportez dans ce fichier, en fin de section, la date, la version de SEB, la
plateforme, la Config Key affichée par l'outil et celle enregistrée par le
portail, et le résultat des étapes 4 et 5. Une seule ligne par exécution suffit,
mais elle doit exister : c'est la seule preuve que la preuve B a été faite.

| Date | Plateforme et version de SEB | Config Key (outil) | Config Key (portail) | Étape 4 | Étape 5 |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
