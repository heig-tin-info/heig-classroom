# Configurer les applications GitHub de production

Le portail utilise deux applications GitHub distinctes (GH-01, AU-08) :

| Application | Rôle | Identité |
| --- | --- | --- |
| **GitHub App** `hgc-prod` | Provisionnement des dépôts, rulesets, webhooks — tout ce que fait le serveur | bot `hgc-prod[bot]` |
| **OAuth App** | Liaison du compte GitHub des étudiants (scope `read:user` uniquement) | — |

Les applications de **dev** (`hgc-dev`, callbacks `localhost:3000`) restent en place
pour le développement local : une OAuth App GitHub n'accepte qu'**un seul** callback,
on ne la fait donc pas pointer vers la prod — on crée une paire dédiée.

## 1. GitHub App `hgc-prod`

Créer dans l'organisation cible :
`https://github.com/organizations/<org>/settings/apps/new`

- **Name** : `hgc-prod` (le slug devient l'identité des commits bot)
- **Homepage URL** : `https://classroom.chevallier.io`
- **Callback URL** : vide ; décocher *Request user authorization (OAuth) during installation*
- **Webhook** : décocher *Active* pour l'instant — il sera activé au jalon M3 avec
  l'URL `https://classroom.chevallier.io/webhooks/github` et un secret
  (`openssl rand -hex 32`, à reporter dans `GITHUB_WEBHOOK_SECRET`)
- **Repository permissions** (table GH-02, rien de plus) :

| Permission | Niveau |
| --- | --- |
| Metadata | Read (automatique) |
| Administration | Read & write |
| Contents | Read & write |
| Workflows | Read & write |
| Pull requests | Read & write |
| Checks | Read |
| Actions | Read |

- **Organization permissions** : Members → Read (optionnel)
- **Where can this App be installed** : *Only on this account*

Après création :

1. Noter l'**App ID** (ou le Client ID `Iv23…`, accepté aussi).
2. *Private keys* → **Generate a private key** → le `.pem` se télécharge.
3. **Install App** (menu de gauche) → l'organisation → **All repositories**.

## 2. OAuth App de production

`https://github.com/organizations/<org>/settings/applications/new`

- **Application name** : `HEIG Classroom`
- **Homepage URL** : `https://classroom.chevallier.io`
- **Authorization callback URL** :
  `https://classroom.chevallier.io/app/auth/github/callback`

Noter le **Client ID**, puis *Generate a new client secret*.

## 3. Installer les valeurs sur le serveur

```bash
# Depuis le poste : déposer le PEM téléchargé
scp hgc-prod.*.private-key.pem root@classroom.chevallier.io:/opt/heig-classroom/secrets/hgc-prod.private-key.pem

ssh root@classroom.chevallier.io
chmod 600 /opt/heig-classroom/secrets/hgc-prod.private-key.pem
chown 1000:1000 /opt/heig-classroom/secrets/hgc-prod.private-key.pem   # uid du conteneur
```

Dans `/opt/heig-classroom/.env.prod` :

```bash
GITHUB_APP_ID=<App ID de hgc-prod>
GITHUB_APP_PRIVATE_KEY_PATH=secrets/hgc-prod.private-key.pem
GITHUB_APP_SLUG=hgc-prod
GITHUB_WEBHOOK_SECRET=            # au jalon M3
GITHUB_OAUTH_CLIENT_ID=<Client ID de l'OAuth App>
GITHUB_OAUTH_CLIENT_SECRET=<client secret>
```

Puis redémarrer l'app :

```bash
cd /opt/heig-classroom
docker compose -f compose.prod.yml --env-file .env.prod up -d app
```

## 4. Vérifier

1. Portail → ouvrir une classroom adossée à l'organisation : badge
   **GitHub App installed** (la résolution d'installation se fait à la consultation).
2. En haut à droite : **Link GitHub** → autorisation `read:user` → badge vert avec
   le login GitHub.
3. Publier un assignment de test et l'accepter avec un compte étudiant : le dépôt
   `slug-<login>` apparaît dans l'organisation, protégé par le ruleset `hgc-protect`.

## Notes

- L'organisation liée à une classroom est celle où l'App est **installée** ; une
  App par organisation d'enseignement (`heig-test-classroom`, `heig-tin-info`, …)
  n'est pas nécessaire : une seule App installée sur chaque organisation suffit.
- La clé PEM ne va **ni dans git ni en base** (ADR-010) ; copie chiffrée dans le
  coffre. Rotation : GitHub accepte deux clés actives simultanément.
- En cas de changement d'App (dev → prod), les dépôts déjà provisionnés restent
  valides : l'App de prod doit simplement être installée sur la même organisation.
