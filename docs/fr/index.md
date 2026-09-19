# HEIG Classroom

HEIG Classroom est le remplaçant, pour le département TIN, de GitHub Classroom
désormais retiré : un petit portail qui transforme une organisation GitHub en
machine à enseigner. Les enseignants publient des devoirs à partir de dépôts Git
ordinaires, chaque étudiant en reçoit une copie privée et protégée en un clic,
un workflow de CI note chaque push, et les dépôts se verrouillent d'eux-mêmes
lorsque le délai de rendu échoit. Le portail tourne à l'adresse
[classroom.chevallier.io](https://classroom.chevallier.io).

Commencez par [À propos](guide/about.md) pour le pourquoi et les flux de
travail. L'hébergement du portail par vos propres moyens est traité dans
[Déploiement](deployment/index.md) — y compris la configuration unique de la
[GitHub App](deployment/github-app.md) ; les enseignants ne créent jamais
d'applications GitHub, installer l'App sur leur organisation se fait en un clic
dans le portail. Le cahier des charges complet et l'architecture se trouvent
dans la section Spécifications, y compris les treize décisions d'architecture
sous `docs/adr/` dans le dépôt.

La pile technique en une phrase : un monolithe Fastify au-dessus de PostgreSQL,
une SPA React, Switch edu-ID pour l'identité et une GitHub App qui fait le gros
du travail, avec des server-sent events qui gardent chaque vue ouverte à jour.

!!! info "Langues"

    L'[anglais](../) est la version de référence de cette
    documentation. Cette version française en est générée automatiquement par
    `pnpm docs:translate` ; en cas de doute, la version anglaise prévaut.
