# What is HEIG Classroom

GitHub deprecated GitHub Classroom in ... , a tool used to orchestrate students repository in assignments. It proposes two alternatives, one free and one not (name the services). However, the need in department TIN for teacher computer science is pretty basic, our needs are:

- Automatically create student repositories from a common template assignment
- Manage write access and hooks on each commit to gather CI results
- Automatically lock the repository passed the deadline
- Have one single source of assignments for each student easy access
- Gather in one single view the results of all CI and get the grade
- Easily Reuse assignments from one year to another
- Allow PR on students repo if fixes needed to be pushed on common repository
- Lock some files on student repo (tests, CI...)
- Squash branches or commits to hide solution or history on the master lab repo which should remain private
- Link GitHub accounts to EDU Id student identificaiton

It seemed easier to build a new platform from scratch for the rentrée académique de l'automne 2026. 

## Teacher workflow

This portal is attempted to be used as follow:

1. A teacher create whereever a GH repository for the lab assignment. He configures the CI to evaluate the work, peut-être avec un LLM pour l'analyse de code, qui retourne le nombre de points obtenus et le nombre de points total
2. An organisation is created to host student repositories, usually the name of the course aka heig-info2-tin-b for the TIN course Info2. A single org for different courses can also be chosen
3. The organisation is promoted into Teams using academic education discount, by applying on GitHub Education
4. The HEIG-Classroom GH App is then installed on the organisation
5. The master assignment repo is forked into the organisation it will live there usually untouched
6. From HEIG-Classroom the teacher creates a new classroom and import the roster from GAPS student list (xlsx file or csv)
7. Then he creates a new assignment linked to the lab repository
8. Once the assignment published students can join

In the mean time HEIG-Classroom will squash all commits into a new reposotiry with suffix `-squashed` which is the SSOT for students assignment. The teacher can clone and append commits into this assignment. Classroom can then automatically create PR on students repo to push some changes. Or classroom may fork this repository to ease this process.

## Student workflow

The student login using Switch EDU ID on the HEIG Classroom portal. The first step is to link with the Student GitHub Account. HEIG Classroom will display all assignment per classroom allowing the student to initiate the fork phase then get the clone URL. 

1. Login into the platform
2. Link GitHub Account
3. Select assignment
4. Wait for initialisation phase
5. Get clone link and clone his repository
6. Work, commit, push...
7. Once the deadline occurs, the repository may be write locked or a signed empty commit "Deadline Reached" can be automatically pushed to lock the history at the deadline
8. The student can get its grade from the interface if a CI was configured by the teacher

