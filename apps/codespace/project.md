# Portal for supervised development environments

Historical framing document (translated). Where it contradicts docs/analyse.md, analyse.md prevails; sections 3 and 4 prevail over everything.

Framing document · 2026-09-17

## 1. Purpose of the document

This document describes a project to be built. It is a basis for analysis, not a frozen specification: the remaining trade-offs are listed in section 10, and assumptions are flagged as such.

What is expected from an analysis based on this document: a critique of the proposed architecture, the identification of blind spots, a reasoned challenge of the technical choices wherever a better option exists, and a realistic development breakdown. Sections 7, 9 and 10 are the most useful to challenge; sections 3 and 4 define the contract and should not be reinterpreted.

Production context: a class of twenty students, a small technical team, no existing Kubernetes platform, an infrastructure budget on the order of a single virtual machine. Any proposal that assumes a dedicated platform team is off topic.

## 2. Context and need

Teaching systems programming in C, with compilation, debugging under gdb and submission through a Git repository. Two recurring problems motivate the project.

The first is the heterogeneity of the workstations. Every start of the academic year burns hours getting a toolchain installed on Windows, macOS and Linux, with behavioural differences that pollute the teaching. An identical environment for everyone, reachable from the browser, removes that cost.

The second is assessment. Since code assistants became widespread, a lab assignment handed in from home no longer measures much. It must be possible to organise a graded assignment in a room, supervised, in an environment where automated assistance is absent and where the authorised documentation is explicitly defined by the teacher.

### The two usage modes

The system must serve two regimes that share the same infrastructure but not the same constraints.

Lab mode. Access from any browser, at any hour. Comfort above all. The container's network lockdown stays active, because it guarantees the reproducibility of the environment, but the student browses freely in their own browser. No claim of control.

Exam mode. Access only from Safe Exam Browser, on a workstation in the room, under human supervision. The student's browsing surface is defined by the teacher. The portal refuses any session that is not authenticated as coming from a correctly configured SEB instance.

The mode is an attribute of the assignment, not a separate instance. That distinction shapes a large part of the requirements that follow: several of them only make sense in exam mode, and treating them uniformly would lead to a needlessly painful system in lab mode.

## 3. Requirements

Every requirement carries a level (mandatory, desirable, optional) and an enforcement point, that is, the technical layer that makes it hold. The enforcement point matters as much as the requirement: several apparently simple requirements turn out to be unenforceable at the layer where one spontaneously places them.

| # | Requirement | Level | Enforcement point |
| --- | --- | --- | --- |
| E1 | The student reaches the service through a single URL, with no prior installation other than SEB | Mandatory | Web portal |
| E2 | Authentication through the institutional OpenID Connect identity | Mandatory | Portal, identity provider |
| E3 | Linking the institutional account to a GitHub account, in one click, retrieving the login and the address | Mandatory | Portal, GitHub App |
| E4 | A working VS Code loads in the browser, with syntax highlighting, completion and C code navigation | Mandatory | code-server inside the container |
| E5 | The student cannot install any extension outside the list defined by the teacher | Mandatory | Image, product.json, extensions.allowed, network |
| E6 | No code assistant is available in the environment | Mandatory | Image, outbound network |
| E7 | A terminal is available, with gcc, gdb, make, git, manual pages | Mandatory | Container image |
| E8 | The student creates and modifies files, which survive the end of the session | Mandatory | Persistent volume |
| E9 | The student can push their work to a designated GitHub repository | Mandatory | The portal's Git proxy |
| E10 | The container reaches no network destination other than those explicitly allowed | Mandatory | nftables on the host |
| E11 | In exam mode, the student's browsing surface is limited to a list defined by the teacher | Mandatory | SEB's URL filter |
| E12 | In exam mode, the portal refuses any session outside a correctly configured SEB | Mandatory | Server-side BEK and Config Key verification |
| E13 | The teacher creates an assignment from an interface, without technical intervention | Mandatory | Portal |
| E14 | The session starts in a few seconds from the student's point of view | Desirable | Pool of pre-warmed containers |
| E15 | Work is never lost, including on a network outage or an abrupt shutdown | Mandatory | Named volume, periodic automatic saving |
| E16 | The container is destroyed after a configurable period of inactivity | Desirable | The portal's garbage collector |
| E17 | The teacher has a timestamped trace of submissions and sessions | Desirable | Git proxy log |
| E18 | Reference documentation available during the exam | Desirable | Local mirrors served by the portal |

### Points of attention on the requirements

E5 rests on three superposed layers, none of which is sufficient on its own. Extensions baked into the image, removal of the extension gallery field from the build's product.json, and the extensions.allowed setting at machine level. The exact behaviour of that setting in builds derived from VS Code must be verified empirically; it is not guaranteed to be identical to that of desktop VS Code.

E9 and E10 are in tension. The naive approach consists in placing an SSH key in the container and opening the network towards GitHub; it reintroduces an exfiltrable secret and a broad destination. The chosen approach is described in section 7.

E11 controls only what the student reads in their browser. E10 controls only what the container's tools reach. These are two distinct lists, with two distinct engines and two distinct semantics. Conflating them in the teacher interface is the most likely design error of this project.

E12 is the keystone of exam mode. Without server-side verification of the keys transmitted by SEB, the student simply opens the portal in an ordinary browser and the whole supervision apparatus becomes decorative.

## 4. Non-goals and accepted limits

These points are explicitly out of scope. Reopening them without necessity will make the project drift.

This is not a multi-institution platform, nor a large-scale multi-class one. The target is twenty simultaneous students, with a reasonable margin up to a hundred. Any optimisation designed for a thousand users is premature.

This is not a complete anti-cheating system. The phone on the lap, the neighbour, the smartwatch are matters for human supervision. The technical apparatus reduces a surface, it does not remove it; pretending otherwise would be dishonest towards the teachers.

This is not a grading system nor an LMS. No assignment texts, no grading scales, no automatic correction. The portal delivers an environment and a submission channel; what happens next belongs to the existing tools.

This is not a multilingual platform in the sense of programming languages. The first scope is the C toolchain, with gcc, gdb and clangd. Extension to other languages must remain possible by simply changing the image, without a redesign, but is not to be addressed now.

The student's browsing is controlled only in exam mode. In lab mode, they have their full browser and the whole internet. That is accepted and desirable.

The isolation aimed at is that of a hardened container, not that of a hypervisor. Moving to gVisor or to a micro virtual machine is an option considered in section 10, not an initial requirement.

## 5. Actors and journeys

### Teacher

They log into the portal with their institutional identity and create an assignment. The form contains: a title, a container image chosen from a short list, the allow list of VS Code extensions, the target GitHub repository or the template it derives from, the mode (lab or exam), the opening window, the list of documentation allowed in exam mode, and the list of network destinations allowed for the container, empty by default.

On validation, the portal produces the derived artefacts: in exam mode, an encrypted SEB configuration file whose Config Key it keeps, and the corresponding launch link. The teacher collects that link and distributes it.

During the session, they consult a dashboard of active sessions, with state, last heartbeat and timestamp of the last submission. They can force a session to close.

### Student, lab mode

They open the portal in their usual browser, authenticate, see the list of their open assignments, click Start. The portal allocates a container, mounts their volume, and redirects them to their VS Code. They work, commit, push. When the tab is closed, the heartbeat stops; after the grace period and then the retention period, the container is destroyed and the volume kept.

### Student, exam mode

They launch Safe Exam Browser from the link provided. SEB downloads the configuration, locks itself into kiosk mode and opens the portal's start URL. The portal verifies the transmitted keys, refuses if they do not match the assignment, then presents the institutional authentication. The rest of the journey is identical, except that the browsing surface is reduced to what the teacher has allowed, and that the documentation tabs are served from the portal.

### Administrator

They build and publish the images, manage the list of images available to teachers, monitor the host machine and restore a volume when needed. That role has no dedicated interface in the first version; they work on the command line on the host.

### Degraded journeys to be treated explicitly

These cases are not details. They constitute half of the real work and must appear in the breakdown.

The student's network goes down during the exam and then comes back. The session must recover without loss and without a full re-authentication.

The container dies, through memory exhaustion or a crash. The portal must restart it on the same volume, without the student having to understand what happened.

The student has not linked a GitHub account at the moment of starting. The portal must offer it to them without losing the context of the assignment.

A student arrives late, or with a workstation on which SEB refuses to start. A documented fallback procedure is needed, decided before the session and not during it.

Two simultaneous sessions on the same assignment, for instance a second tab. The expected behaviour must be chosen: refusal, resumption of the existing session, or sharing.

## 6. State of the art and chosen position

### What was ruled out, and why

GitHub Codespaces with GitHub Classroom covers authentication, the browser IDE, persistence and Git submission without a line of code. It fails on E10 structurally: the GitHub documentation states that there is no way to restrict a codespace's access to the public internet, codespaces being allowed to open outbound connections. Exam mode is therefore out of reach. GitHub Classroom remains of interest for the creation of student repositories from a template alone, to be evaluated in section 10.

Coder, the self-hosted remote development platform, is the serious candidate. The community edition brings OpenID Connect SSO, workspaces defined in Terraform on Docker or Kubernetes, the authenticated web proxy to the IDE and automatic shutdown on inactivity. It is ruled out as an initial foundation for a reason of form, not of quality: the portal described here carries a pedagogical logic, assignments, extension lists and SEB filtering, which do not express themselves naturally as Terraform template variables. On twenty workstations, the indirection costs more than it returns. It will become relevant again the day several hosts, per-group quotas and an audit trail are needed.

Eclipse Che answers the need natively in Kubernetes and handles extension locking through a ConfigMap, which is exactly E5. The operating cost of a cluster for twenty students is disproportionate.

JupyterHub with DockerSpawner and code-server is a proven basis in a teaching context, with OIDC authentication, a per-user lifecycle and shutdown of idle sessions. The mental model remains notebook-centred and extending it towards the assignment logic described here takes as much work as direct development.

Gitpod no longer has a community self-hosted offering. Kasm Workspaces reserves single sign-on for the paid editions.

### What is reused

Safe Exam Browser, an open project of ETH Zurich, provides the kiosk browser, URL filtering by configuration and above all the proof mechanism, Browser Exam Key and Config Key, that the portal must verify. There is no official version for Linux; only Windows, macOS and iOS are published, which constrains the fleet of the exam room.

SEB Server, an official component of the same project, centralises the configuration of the clients for an exam and allows real-time monitoring of the connected clients. It covers part of the teacher-facing work and deserves an evaluation before writing that part of the portal.

code-server or openvscode-server provide the browser VS Code, built on the open base of VS Code, and therefore free of the proprietary code assistance components.

### Position

In-house development of a thin portal, on top of existing building blocks, orchestrating containers directly. The portal invents neither the IDE, nor the exam browser, nor the container engine. It brings three things that nothing provides assembled: the assignment logic, the server-side SEB verification, and a Git channel with no secret inside the container.

## 7. Target architecture

### Overview

A single virtual machine carries the whole. Eight cores, thirty-two gigabytes of RAM and two hundred gigabytes of fast storage absorb twenty C compilation sessions with a comfortable margin.

On that host, five components. A TLS front end, a portal service, a container engine, a set of persistent volumes, and a set of documentation mirrors served locally. The portal service is the only code written for this project.

### The portal service

It exposes four distinct surfaces, and that separation must appear in the code because the access rules differ.

A student interface and a teacher interface, authenticated by OpenID Connect.

A proxy to the containers, which relays HTTP requests and websockets to the session's code-server, after verifying the session token and, in exam mode, the SEB provenance.

A Git proxy, which speaks the smart Git HTTP protocol, authenticates by the session token and relays to GitHub with its own application token. This is the non-trivial piece of the architecture, described further down.

An orchestrator, which allocates, monitors and destroys the containers, maintains a pool of pre-warmed containers and runs the garbage collector.

### Identity

Authentication by OpenID Connect against the institutional provider. The portal keeps a stable identifier and an e-mail address, nothing else.

GitHub linking through a GitHub application installed on the organisation, and not through a plain OAuth application. That gives, on the one hand, the student's identity through the OAuth flow of that same application, and on the other hand installation tokens with a reduced scope and a lifetime of one hour, which the portal uses to talk to the repositories without ever holding a long-lived secret on the student's behalf.

### The Git channel, without a secret in the container

The container receives an already cloned repository, with a remote pointing at the portal, of the form portal.acme.com/git/session-identifier. It holds neither an SSH key, nor a token, nor a persistent credential helper. Authentication rests on the session token, injected at start-up into the container's Git configuration and revoked when it is destroyed. [superseded: see analyse.md § 3.1 / CLAUDE.md invariant 1 — no secret enters the container; the Git channel authenticates by the container's source IP address on the `codespace` bridge]

The portal implements the smart Git HTTP protocol. It allows receive-pack, that is, pushing, and refuses upload-pack, that is, cloning and fetching. That refusal is not a cosmetic precaution: it closes the path by which a student would introduce an extension file into their environment from the outside. [superseded: see analyse.md § 3.2 — `upload-pack` is allowed on the staging repository in both modes; the E5 barrier is the read-only extensions directory in the image]

The benefits accumulate. The container's network allow list boils down to a single internal destination. No secret is exfiltrable. Every push is logged with a timestamp, a commit fingerprint and a session, which settles submission disputes without discussion.

### Containerisation and hardening

The choice between Docker and Podman is not settled; it appears in section 10. In both cases, the hardening aimed at is the same.

A distinct user namespace per container, so that an escape lands on an unprivileged identifier. All capabilities dropped, except CAP_SYS_PTRACE. A seccomp profile derived from the default profile, allowing the personality system call, failing which gdb will fail to disable address space layout randomisation. Read-only root filesystem, tmpfs on the temporary directories, no privilege escalation allowed. Process limit of two hundred and fifty-six, memory limit of two gigabytes, CPU limit of one core.

A single bridged network dedicated to the containers, with a default nftables policy of rejecting outbound traffic and two exceptions: the port of the portal's Git proxy, and the internal split-view DNS resolver. Nothing else.

### Persistence

One named volume per (student, assignment) pair, independent of the container's lifecycle. The container is cattle, the work is not.

A periodic automatic save, on the order of two to three minutes, in the form of a commit on a dedicated working branch, distinct from the submission branch. Without that safety net, the first exam session will produce a work-loss incident, and it will be the only one the institution remembers.

### The exam side

For every assignment in exam mode, the portal generates an encrypted SEB configuration file containing the URL filtering rules, the start URL pointing at the session, the kiosk settings, and the download and clipboard policy. It keeps the associated Config Key as well as the Browser Exam Key of the deployed SEB version.

Launching is done through a link with the sebs scheme, which SEB recognises, which makes it fetch the configuration and start without any file handling by the student.

The server-side verification covers three surfaces, and not only the home page: the session start page, the call that creates the container, and the proxy to code-server. Verifying only the first leaves open the copying of the session URL into an ordinary browser. In practice: strict verification on opening, issuing a session cookie bound to that verification, and refusal of any proxy request lacking that cookie.

### Offline documentation

Rather than allowing real sites in the SEB filter, the portal serves local mirrors under its own paths: a Kiwix archive for the encyclopaedia, a DevDocs instance, a copy of the C and C++ reference, the manual pages. The SEB filtering list then boils down to a single domain rule, which removes the question of third-party content delivery networks and of the ancillary domains that every real site drags along. The content is identical for everyone and reproducible from one session to the next.

## 8. Data model

Four entities are enough. Any fifth entity added in the first version must be justified.

User. Institutional identifier, e-mail address, role, GitHub login, GitHub numeric identifier, linking date.

Assignment. Title, owning teacher, container image, extension allow list, mode, opening window, repository template or naming convention, list of network destinations allowed for the container, list of documentation allowed for SEB, SEB configuration blob, Config Key, reference Browser Exam Key.

Session. Student, assignment, container identifier, volume identifier, state, creation timestamp, last heartbeat, session token, SEB verification flag.

PushEvent. Session, timestamp, Git reference, commit fingerprint, result. That table is the only proof of submission; it must be written before the relay to GitHub is attempted, and completed afterwards.

A lightweight relational database is amply sufficient at that scale. The choice of engine is of no consequence; the only real constraint is that the session states support recovery after a restart of the portal, that is, that the orchestrator be able to rebuild its state from the database and from the inventory of live containers.

## 9. Threat model

The adversary is a motivated, technically competent student, with preparation time before the exam but limited time during it. They are not assumed to have exploits against up-to-date components. They are assumed to share their findings with their cohort, so any flaw discovered once is deemed known to everyone at the next session.

| Vector | Effect | Counter-measure |
| --- | --- | --- |
| Opening the portal outside SEB | Total bypass of exam mode | BEK and Config Key verification on the three surfaces, cookie bound to the verification |
| Forging the SEB proof header | Idem | The BEK must never be exposed client-side nor transmitted to the student |
| Modifying the SEB configuration file | URL filter disabled | Config Key derived from the settings, therefore invalidated by any modification; file encryption |
| Reading a Git secret in the container | Push from the outside, exfiltration | No secret in the container, session token revoked on destruction |
| Fetching an extension file through git pull | Bypass of the extension allow list | upload-pack refused by the Git proxy, cloning done at provisioning time |
| Installing an extension from the gallery | Idem | Gallery field removed from product.json, extensions.allowed setting, marketplace unreachable |
| Using a browser internal to VS Code | Browsing outside the apparent filter | The requests come from the browser, therefore subject to the SEB filter; check that web views are served from the portal's origin and not from a third-party content delivery network |
| Exfiltration through DNS requests | Disguised outbound channel | Internal split-view resolver, no reachable public resolver |
| Container escape | Access to the host and to the other sessions | User namespace, minimal capabilities, seccomp, read-only root; gVisor option in exam mode |
| Resource exhaustion, fork bomb | Denial of service on the whole class | Process, memory and CPU limits per container; disk quota per volume |
| Second device, phone, neighbour | External assistance | Out of technical scope, a matter for human supervision |

### The three structural weaknesses to accept

The SEB verification rests on a secret shared between the portal and the SEB binary. A student who obtains the Browser Exam Key can forge the headers from an ordinary browser. Rotating that secret at every exam session, and not exposing it in the teacher interface, are therefore operational requirements and not details.

SEB's URL filter exists only on the platforms where SEB exists, that is, not Linux in an official version. A heterogeneous room fleet mechanically weakens the apparatus.

The terminal gives a full command shell inside a container. It is the entry point of any possible escape, and it is irreducible since it is precisely the feature asked for. Hardening reduces the probability, it does not cancel it.

## 10. Open decisions

These trade-offs are not settled. They are the points on which an external analysis brings the most value.

### D1. Docker or Podman

Podman's unprivileged mode is the right reflex for running untrusted code, but it moves the network stack into user space, through pasta or slirp4netns, which invalidates the application of the nftables rules as described in section 7. Filtering becomes possible elsewhere, but differently.

The foreseen compromise is a privileged engine, Docker or Podman indifferently, with automatic user namespaces, keeping a classic virtual interface and therefore nftables filtering upstream on the bridge. That compromise must be verified experimentally before being adopted, because it conditions E10.

Arbitration criterion: the ability to demonstrate, by test, that a process inside the container reaches no destination outside the allow list.

### D2. Reinforced isolation in exam mode

Should exam containers be switched to gVisor, or even to a Firecracker-style micro virtual machine, keeping ordinary containers for lab work? The extra cost is marginal at that scale and the argument is solid in front of a legal department. The reservation concerns gdb: gVisor's coverage of ptrace is correct but not identical, and must be proven before committing.

### D3. Repository provisioning

GitHub Classroom already creates student repositories from a template and manages the mapping between student identity and repository. Consuming that mapping rather than reimplementing it saves a week of development, at the price of an additional coupling and of a double interface for the teacher. To be decided according to the existing practices of the institution.

### D4. Extent of SEB Server

SEB Server covers the centralised configuration of the clients and real-time monitoring. Three possible positions: ignore it and do everything in the portal, use it as a generator and distributor of configurations while keeping the portal as the entry point, or make it the entry point of the exam and reduce the portal to the working environment. The second position seems the best but requires an evaluation of its programmatic interface.

### D5. Semantics of the simultaneous session

What happens if a student opens a second tab on the same assignment? Refusing is the simplest and safest in an exam. Resuming the existing session is the most comfortable in lab work. The behaviour could depend on the mode, at the price of an apparent inconsistency.

### D6. Volume granularity

One volume per (student, assignment) pair isolates well but multiplies the objects and complicates backup. One volume per student, with one directory per assignment, simplifies operations but lets the student consult during an exam the work of another assignment, which may or may not be desirable depending on the pedagogy.

### D7. What exactly the teacher's network list does

If the documentation is served as a local mirror, the list of network destinations allowed for the container no longer has much use and could disappear from the teacher interface, replaced by a simple choice of image. Removing a useless setting is better than exposing it and letting people believe it protects something.

### D8. Language and stack of the portal

No strong constraint. The only particular needs are a robust websocket proxy, an implementation of or a delegation to the smart Git HTTP protocol, and a container engine client. Those three needs are better served by some stacks than others, which should guide the choice more than team preferences.

## 11. Development strategy

### Guiding principle

The risks of this project are not in the interface, they are in three unverified technical assumptions. As long as they are not lifted, any interface development is potentially thrown-away work. The order of the milestones follows entirely from that observation.

### Milestone 0: lift the three unknowns

Three proofs, with no interface, in scripts and on the command line.

Proof A. code-server rendered correctly in SEB's embedded browser, on the platform of the room, with working websockets, service workers and local storage. A failure here invalidates the IDE choice, not the project.

Proof B. Browser Exam Key and Config Key verification working on a protected route, tested by attempting access from an ordinary browser, which must fail.

Proof C. A container that pushes to GitHub through the Git proxy, with no secret inside it, with upload-pack refused and network filtering active.

Without those three proofs, there is no project. With them, the rest is assembly.

### Milestone 1: complete local skeleton

The portal end to end on a development workstation, with simulated authentication, a hard-coded assignment, a container, a volume, the IDE proxy and the Git proxy. No teacher interface, no exam mode, no pool. Goal: a fictional student starts, writes code, compiles, pushes.

### Milestone 2: real identity

Connecting the institutional OpenID Connect provider and the GitHub application. Replacing the simulator with the real flows, without the rest of the code noticing. If that replacement requires touching anything other than the authentication layer, then milestone 1 isolated that layer badly.

### Milestone 3: exam mode

Generation of the SEB configurations, key management, verification on the three surfaces, URL filtering, documentation mirrors. It is the riskiest milestone in operations and it must be proven under real room conditions, not only in development.

### Milestone 4: teacher interface

Assignment creation, extension lists, dashboard of active sessions. Deliberately late: as long as teachers are not in the loop, a configuration file is enough, and the real needs of the interface reveal themselves only after a first lived session.

### Milestone 5: operations

Pool of pre-warmed containers, garbage collector, backups, monitoring, fallback procedures. That is what turns a demonstration into a service.

### Sequencing and effort

Milestone 0 is measured in days, not weeks, and conditions everything else. Milestones 1 and 2 form the technical core. Milestones 3 to 5 represent about half of the total effort, which is systematically surprising in this kind of project: degraded cases and operations weigh as much as the nominal functionality.

A realistic pilot consists in running an ordinary lab session with a small volunteer group after milestone 2, well before any use in an exam. The exam must be the last use put into production, never the first.

## 12. Local development environment

### Goal

The whole thing must run on a development workstation, without any dependency on institutional infrastructure, without a mandatory real GitHub account, and without SEB for day-to-day development. That is the condition for the work cycle to stay fast and for several people to be able to contribute.

### What is simulated

Institutional authentication. A fake OpenID Connect provider, either a protocol-conformant test server or a local adapter that issues the same tokens. The essential point is that the portal speaks the real protocol even locally, with discovery, code exchange and token validation. A shortcut such as an environment variable containing a user identifier would make milestone 2 painful, because the authentication layer would never have been exercised.

A user selector in development makes it possible to switch between a student and a teacher without leaving the browser.

The Git destination. A local forge, Gitea or Forgejo in a container, replaces GitHub. The Git proxy relays to it. That makes it possible to test the refusal of upload-pack, the logging of pushes and error handling without depending on a network or on a programmatic interface quota.

### What must absolutely not be simulated

Network filtering. It must be active from day one, on the development workstation, failing which the project will discover in pre-production that the chosen container configuration makes it inapplicable. That is unknown D1, and the only way to lift it is to live with it continuously.

Container hardening. Capabilities, seccomp, the limits and the read-only root must be in place from milestone 1 on. Adding them afterwards amounts to discovering late that gdb no longer works, or that the language server is short of memory.

The Git proxy. It carries a central security requirement; a local shortcut that placed a key in the container to go faster would create a parallel architecture that would have to be undone.

The authentication protocol, as stated above.

### Expected form

A composition file for the development environment, carrying the portal, the fake identity provider, the local forge and the documentation mirrors. The host's container engine is used directly by the portal for the student containers, which are not part of the composition since they are created dynamically.

A seed data set: two students, one teacher, one assignment in lab mode, one assignment in exam mode, a starting repository in the local forge.

### Handling exam mode locally

SEB will not be installed on every development workstation. The verification must nonetheless be developed and tested. The chosen form is a double implementation of the verification, one real and one simulated, selected by configuration, with an automated test set that covers both and above all the refusal cases. The manual test with a real SEB remains mandatory before milestone 3, on a dedicated machine, but does not condition day-to-day development.

## 13. Risks, success, questions for the analysis

### Main risks

Incompatibility of code-server with SEB's embedded browser. Medium probability, high impact: forces a change of browser IDE. Handled by milestone 0.

Network filtering inapplicable in the chosen container configuration. Medium probability, high impact: calls D1 and potentially the choice of engine into question. Handled by milestone 0 and by the ban on simulating that layer locally.

Absence of an official SEB on Linux constraining the room fleet. Certain probability, impact varying with the institution. To be investigated before any commitment to exam mode.

Loss of a student's work during an exam. Low probability if the safety net is in place, major institutional impact. That is the risk that on its own justifies periodic automatic saving and the volume decoupled from the container.

A VS Code update breaking the extension locking or the product.json modification. High probability over time. Handled by freezing the image version and by a check before every exam period.

Scope creep towards a course management system. High probability as soon as teachers discover the tool. Handled by section 4.

### Success criteria

A two-hour lab session with twenty students and no technical intervention.

Time between the Start click and a usable editor under ten seconds as perceived.

No work lost over a full session, including when simulating outages.

One documented attempt at access outside SEB that fails.

A teacher creates an assignment end to end without assistance.

### Questions addressed to the analysis

Is the architecture of the Git channel without a secret the right answer to the tension between E9 and E10, or is there a simpler approach offering the same guarantees?

Is refusing upload-pack tenable in teaching practice, given that it prevents the student from fetching a correction or an update of the assignment text during the session? What alternative would preserve the guarantee?

Is the choice not to start from Coder justified at that scale, or is the cost of in-house orchestration underestimated?

The milestone breakdown puts the teacher interface late. Is that sustainable from the point of view of user adoption, or is a non-functional mock-up needed earlier?

What blind spots are missing from this document? The expected candidates concern accessibility, compliance with the processing of students' personal data, the retention of session traces and its duration, and the obligations regarding exam accommodations.
