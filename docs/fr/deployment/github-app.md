# La GitHub App

Le portail parle à GitHub à travers **une seule et unique GitHub App** — en production :
[`heig-classroom`](https://github.com/apps/heig-classroom), détenue par
`heig-tin-info`. Elle fait tout ce que le serveur fait sur les dépôts
(provisionnement, rulesets, webhooks) sous l'identité `heig-classroom[bot]`,
**et** porte le flux OAuth user-to-server qui lie les comptes étudiants — une
GitHub App accepte jusqu'à dix URL de callback et ses jetons utilisateur servent
`GET /user` sans aucune portée, si bien qu'aucune OAuth App séparée n'est nécessaire.

**L'App est créée une seule fois, par l'opérateur, dans le cadre du déploiement
de la plateforme.** Les enseignants ne créent ni ne configurent jamais d'app :
l'installer sur leur organisation tient en un clic dans le portail (voir
*Prise en main d'une organisation* ci-dessous). Notez qu'une GitHub App ne peut
jamais changer de propriétaire — créez-la sous l'organisation qui doit la
posséder pour toujours (`heig-tin-info`), pas sous une organisation de test.

## Créer l'App (opérateur, une seule fois)

Créez-la à l'adresse `https://github.com/organizations/<owner-org>/settings/apps/new`
et remplissez :

- **Name** : `heig-classroom` (le slug devient l'identité du bot sur les commits)
- **Description** (affichée sur les écrans d'installation et d'autorisation) :

```text
HEIG Classroom drives the student repositories of this organization: it creates
one private repository per student and assignment, grants push access, protects
assignment files, collects CI results, and locks repositories at the deadline.
Operated by the TIN department at HEIG-VD. Portal: https://classroom.chevallier.io
```

- **Homepage URL** : `https://classroom.chevallier.io`
- **Callback URL** : `https://classroom.chevallier.io/app/auth/github/callback`
  (liaison de compte), et laissez *Request user authorization (OAuth) during
  installation* **décoché** — la liaison reste un acte séparé.
- **Setup URL** : `https://classroom.chevallier.io/setup/github/installed` et
  cochez *Redirect on update*. C'est ce qui rend l'assistant d'installation
  fluide : GitHub renvoie le propriétaire vers la classe et le badge passe au
  vert en direct.
- **Webhook** : *Active*, `https://classroom.chevallier.io/webhooks/github`,
  secret répliqué dans `GITHUB_WEBHOOK_SECRET`.
- **Where can this App be installed** : **Any account** — c'est ce qui permet à
  un enseignant de l'installer en un clic sur une organisation toute neuve.

### Permissions de dépôt

| Permission | Niveau | Pourquoi |
| --- | --- | --- |
| Actions | Read | lire les exécutions de workflow (résultats du pipeline de notation) |
| Administration | Read & write | créer les dépôts, les rulesets, les verrouillages au délai de rendu |
| Checks | Read | lire les annotations de check run (GRADE / TESTS) |
| Contents | Read & write | pousser les squelettes, les marqueurs de délai de rendu, les reverts de fichiers protégés |
| Metadata | Read | socle obligatoire |
| Pull requests | Read & write | ouvrir et suivre les pull requests de synchronisation |
| Workflows | Read & write | livrer `.github/workflows/grading.yml` vers les dépôts étudiants |

### Permissions d'organisation

| Permission | Niveau | Pourquoi |
| --- | --- | --- |
| Members | Read | lever l'indication « accepter l'invitation », recoupements avec la liste des étudiants |
| Plan | Read | détecter les organisations en plan gratuit (les secrets d'organisation n'y atteignent pas les dépôts privés) et suggérer la [mise à niveau enseignant](https://education.github.com/globalcampus/teacher) |

### Événements de webhook

| Événement | Pourquoi |
| --- | --- |
| Push | métriques de dépôt, fichiers protégés, détection d'une source en avance, accusés de push |
| Workflow run | statut CI et capture de la note |
| Pull request | suivi des pull requests de synchronisation |
| Member | lève l'indication « accepter l'invitation GitHub » au moment de l'acceptation |
| Repository | renommages ou suppressions hors bande de dépôts étudiants |
| Organization | organisation renommée ou supprimée — garder exacts les enregistrements d'organisation du portail |

Les événements d'installation sont toujours livrés aux GitHub Apps ; aucun
abonnement n'est nécessaire.

Une fois l'App créée : notez l'**App ID** et le **Client ID**, générez un **client
secret** (liaison de compte) et une **clé privée** (un `.pem` se télécharge).

## Installer les valeurs sur le serveur

```bash
# From your workstation, ship the downloaded PEM
scp heig-classroom.*.private-key.pem root@classroom.chevallier.io:/opt/heig-classroom/secrets/heig-classroom.private-key.pem

ssh root@classroom.chevallier.io
chmod 600 /opt/heig-classroom/secrets/heig-classroom.private-key.pem
chown 1000:1000 /opt/heig-classroom/secrets/heig-classroom.private-key.pem   # container uid
```

Dans `/opt/heig-classroom/.env.prod` :

```bash
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_PATH=secrets/heig-classroom.private-key.pem
GITHUB_APP_SLUG=heig-classroom
GITHUB_WEBHOOK_SECRET=<webhook secret>
GITHUB_APP_CLIENT_ID=<Client ID of the App>
GITHUB_APP_CLIENT_SECRET=<client secret of the App>
```

Puis `docker compose -f compose.prod.yml --env-file .env.prod up -d app`.

## Prise en main d'une organisation (ce que fait un enseignant)

1. **Créer l'organisation** sur GitHub si nécessaire (le plan gratuit suffit pour
   commencer) — le formulaire de création de classe y renvoie.
2. **Créer la classe** dans le portail, en saisissant le login de l'organisation.
3. La page de la classe affiche l'assistant **Connect GitHub** : un clic sur
   *Install the GitHub App* (l'enseignant doit être owner de l'organisation,
   choisissez **All repositories**), GitHub valide les permissions, et le badge
   passe au vert de lui-même.

Rien à configurer côté serveur, aucun secret à transporter : **une App,
N installations**.

## Vérifier

Dans l'en-tête du portail, **Link GitHub** doit dérouler l'autorisation de l'App
et revenir avec votre login sous forme de badge vert. Publiez un devoir de test
et acceptez-le avec un compte étudiant : le dépôt `slug-<login>` apparaît dans
l'organisation, protégé par le ruleset `hgc-protect`.

## Notes

La même App sert toutes les classes de toutes les organisations où elle est
installée. La clé PEM ne va jamais dans git ni dans la base de données
(ADR-010) ; conservez-en une copie chiffrée dans le coffre. GitHub accepte deux
clés actives à la fois, ce qui rend la rotation indolore. Les limites de débit
sont **par installation**, les organisations ne se concurrencent donc pas entre
elles. Les compromis du modèle à App unique — une seule identité de bot
partagée, une seule clé privée pour toutes les organisations — sont acceptables
pour une institution unique ; si une organisation externe venait un jour à
exiger l'isolation, le *manifest flow* des GitHub App est la porte de sortie
(une app par organisation générée en deux clics).
