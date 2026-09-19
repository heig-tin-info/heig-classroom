# Notation automatique

HEIG Classroom note le travail des étudiants en lisant une unique annotation
issue de l'exécution GitHub Actions : il n'y a donc aucun artefact à téléverser,
aucun token à injecter dans les dépôts étudiants, et la note est visible dans
l'interface GitHub exactement telle que la plateforme l'enregistre.

## Fonctionnement

Votre dépôt de devoir embarque un workflow dans `.github/workflows/grading.yml`.
Lorsqu'un étudiant pousse, le workflow exécute ses tests et émet une commande de
workflow à sa dernière étape :

```bash
echo "::notice title=GRADE::4.5/6"
```

Cette commande crée une annotation de check run intitulée `GRADE`. La plateforme
reçoit le webhook `workflow_run`, lit les annotations grâce à sa permission
`checks:read`, analyse `points/max` et enregistre une exécution de notation. La
note apparaît alors en direct dans votre vue du devoir et sur le tableau de bord
de l'étudiant, marquée comme indicative.

Le message doit correspondre à `points/max`, les décimales étant écrites avec un
point, `max` strictement supérieur à zéro et `points` n'excédant pas `max`. Tout
le reste est enregistré comme malformé et signalé dans la vue enseignant.

N'émettez l'annotation qu'une seule fois par exécution. Deux annotations `GRADE`
dans la même exécution invalident la note, même lorsqu'elles portent la même
valeur. C'est la protection contre les étudiants qui afficheraient une
annotation falsifiée depuis leur propre code de test : la falsifiée plus la
vôtre en font deux, et la note est annulée pour que vous puissiez l'examiner.

## Modèle

```yaml
name: grading

on:
  push:
    branches: [main]

jobs:
  grade:
    runs-on: ubuntu-latest
    # Bot pushes (protected-file restores, deadline markers, sync branches)
    # must not consume Actions minutes nor produce grade runs.
    if: github.actor != 'hgc-prod[bot]'
    steps:
      - uses: actions/checkout@v6

      - name: Run tests
        id: tests
        continue-on-error: true
        run: |
          # Replace with your real test command; write the score you computed
          # to the step output so the final step can publish it.
          POINTS=$(./run-tests.sh --score)
          echo "points=$POINTS" >> "$GITHUB_OUTPUT"

      - name: Publish grade
        if: always()
        run: |
          echo "::notice title=GRADE::${{ steps.tests.outputs.points || '0' }}/6"
```

L'étape finale s'exécute avec `if: always()` pour que la note soit publiée même
lorsqu'une étape de test échoue, et c'est la seule étape autorisée à émettre
l'annotation. Sur l'instance de développement, le compte du bot est
`hgc-dev[bot]` au lieu de `hgc-prod[bot]`.

## Ce que la plateforme enregistre

Chaque exécution éligible devient une exécution de notation immuable : éligible
signifie que la branche de l'exécution fait partie des branches sélectionnées du
devoir et que le commit de tête n'a pas été poussé par le bot de la plateforme.
La note courante est la plus récente exécution reçue avant le délai de rendu
dont l'annotation a été correctement analysée. Les dépôts dépourvus de
`grading.yml` bénéficient tout de même d'un suivi réussite/échec agrégé sur
leurs exécutions de workflow.

Au délai de rendu, la note courante est gelée. Pendant la période de grâce
(30 minutes par défaut), les exécutions qui évaluent des commits poussés avant
le délai de rendu peuvent encore améliorer la note gelée, ce qui couvre
l'exécution encore en cours au moment de l'échéance. Ce qui compte, c'est le
moment où la plateforme a reçu le push, jamais l'horodatage git, qu'un étudiant
peut trivialement falsifier. Après la période de grâce, la note gelée est
définitive ; les exécutions ultérieures restent dans l'historique avec un badge
« après le délai de rendu », visible par vous mais n'affectant jamais la note
gelée.

Conservez `grading.yml` dans les fichiers protégés du devoir (il est
présélectionné à la création). La note demeure indicative plutôt que
contractuelle : le code étudiant s'exécute dans le même job que l'annotation, de
sorte qu'un étudiant déterminé peut la détourner, et les mesures ci-dessus
rendent cela visible plutôt qu'impossible. Traitez-la comme un retour continu ;
l'évaluation qui fait foi reste la vôtre.

## Revue LLM au délai de rendu

La note déclenchée par push décrite ci-dessus constitue le niveau *indicatif*.
Une fois la note d'un devoir définitivement gelée (délai de rendu + période de
grâce), la plateforme déclenche un événement `repository_dispatch` sur chaque
dépôt étudiant :

```json
POST /repos/{owner}/{repo}/dispatches
{
  "event_type": "grade-final",
  "client_payload": {
    "sha": "<frozen commit>",
    "assignment_id": "…",
    "deadline": "2026-07-03T21:59:00.000Z",
    "trigger": "deadline"
  }
}
```

`client_payload.sha` est le commit de tête de l'exécution de notation **gelée**
— la dernière exécution sur un commit reçu avant le délai de rendu — jamais le
HEAD courant : les pushes tardifs sont donc ignorés par la revue exactement
comme ils le sont par le gel. Les dépôts dans lesquels l'étudiant n'a jamais
produit d'exécution éligible sont passés outre. Chaque dispatch est consigné
dans un registre (un par dépôt et par déclencheur), de sorte que les
redémarrages de worker et les nouvelles tentatives de pg-boss ne déclenchent
jamais la revue deux fois.

Le dépôt étudiant réagit dans `grading.yml` : un job `llm-review` gardé par
`if: github.event_name == 'repository_dispatch'` récupère
`client_payload.sha`, note chaque critère avec
[`score grade --llm`](https://github.com/heig-tin-info/score), committe la revue
détaillée `GRADING.yml` dans le dépôt et publie la note comme unique annotation
`GRADE` de l'exécution. Lors d'un dispatch, seul le job de revue peut émettre
l'annotation (le job objectif doit être gardé par
`github.event_name == 'push'`), ce qui préserve la règle de l'annotation unique.
Le workflow réutilisable `heig-tin-info/score/.github/workflows/grading.yml` met
en œuvre les deux niveaux ; les dépôts étudiants ne portent qu'une fine
surcouche qui l'appelle.

L'exécution de revue terminée revient par l'ingestion `workflow_run`
habituelle, mais elle est enregistrée à part : la plateforme classe les
exécutions déclenchées par `repository_dispatch` sur `grading.yml` comme `llm`
et les range dans leur propre emplacement, à côté de la note de CI gelée — la
revue ne remplace jamais la note gelée, et les deux sont visibles dans les vues
enseignant et étudiant.

Exigences opérationnelles :

- **Contents: write** sur l'installation de l'App — requis par le point d'accès
  des dispatches et déjà inclus dans l'ensemble des permissions de la
  plateforme.
- **`ANTHROPIC_API_KEY`** comme secret d'organisation limité aux dépôts de la
  classe : le job de revue en a besoin pour appeler le modèle. Fixez une limite
  de dépense sur la clé et renouvelez-la chaque semestre. La clé n'est exposée
  qu'à l'étape `score grade`, jamais aux étapes de construction et de test qui
  exécutent le code étudiant ; le chemin d'exfiltration qui subsiste est un
  `grading.yml` altéré, raison pour laquelle ce fichier doit rester dans les
  fichiers protégés.
- Le commit de revue est poussé avec le `GITHUB_TOKEN` par défaut du workflow —
  à dessein, et **jamais un PAT** : GitHub ne déclenche pas de workflows pour
  les pushes effectués avec `GITHUB_TOKEN`, ce qui rend toute boucle de notation
  impossible. La plateforme enregistre ces pushes (émetteur
  `github-actions[bot]`) comme des commits de bot : ils ne produisent donc
  jamais d'exécution de notation et ne comptent pas comme activité étudiante.
- Un type de dispatch `grade-milestone` est réservé aux jalons intermédiaires
  (même mécanique, une ligne de registre par jalon) ; les jalons ne sont pas
  encore implémentés.

### Configurer la clé d'API Anthropic

Le job de revue lit la clé depuis `secrets.ANTHROPIC_API_KEY`. Fournissez-la une
seule fois, comme **secret d'organisation limité aux dépôts de la classe**, afin
que chaque dépôt étudiant en hérite sans jamais stocker la clé en clair.

1. **Créez la clé** dans la [console Anthropic](https://console.anthropic.com)
   sous *Settings → API keys*. Utilisez une clé dédiée à la classe (afin de
   pouvoir la révoquer sans rien affecter d'autre), placez-la dans son propre
   espace de travail et fixez une **limite de dépense** mensuelle sur cet espace
   de travail — la clé sert à la notation de code étudiant non fiable et vous
   voulez un plafond ferme. Copiez la valeur `sk-ant-…` ; la console ne
   l'affiche qu'une seule fois.

2. **Stockez-la comme secret d'organisation**, restreint aux dépôts de la
   classe.

   Depuis l'interface GitHub : *Organization → Settings → Secrets and variables
   → Actions → New organization secret*. Nommez-le `ANTHROPIC_API_KEY`, collez
   la valeur, puis sous *Repository access* choisissez **Selected
   repositories** et ajoutez les dépôts du devoir (source, squashé et ceux de
   chaque étudiant). Ne choisissez jamais *All repositories* : cela exposerait
   la clé à n'importe quel dépôt de l'organisation, y compris à ceux extérieurs
   au cours.

   Ou avec la CLI (nécessite `admin:org`) :

   ```bash
   gh secret set ANTHROPIC_API_KEY \
     --org <your-org> \
     --app actions \
     --visibility selected \
     --repos "labo-02-quadratic,labo-02-quadratic-squashed" \
     --body "sk-ant-..."
   ```

   À mesure que de nouveaux dépôts étudiants sont provisionnés, ajoutez-les à la
   liste des dépôts sélectionnés du secret (ou accordez le secret à l'ensemble
   complet une fois le motif de nommage connu). Un dépôt qui ne peut pas lire le
   secret exécute tout de même le job de revue, mais `score grade --llm` échoue
   faute de clé et l'exécution n'enregistre aucune note — ce qui est visible
   dans la vue enseignant plutôt que silencieux.

3. **Renouvelez-la chaque semestre** (ou dès qu'une clé a pu fuiter) : créez une
   nouvelle clé dans la console, mettez à jour le secret d'organisation avec la
   commande ci-dessus, puis révoquez l'ancienne clé. Aucune modification de
   workflow n'est nécessaire — le nom du secret est stable.

Le workflow de surcouche transmet le secret au pipeline réutilisable par une
**correspondance explicite** — il ne faut PAS se reposer sur `secrets: inherit`
ici : les secrets d'organisation ne franchissent pas la frontière de
l'organisation lorsque le workflow réutilisable réside dans une autre
organisation (`heig-tin-info/score` face à l'organisation de la classe). Avec
`inherit`, le niveau LLM s'exécute avec une clé vide et échoue ; la surcouche
déclare donc :

```yaml
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Rien d'autre n'a besoin d'être configuré du côté étudiant.
