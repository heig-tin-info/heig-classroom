# Critical analysis of the framing document

Answer to [project.md](../project.md) · 2026-09-17

This document does what section 1 of the framing document asks for: challenge the choices of sections 7, 9 and 10, name the blind spots, and propose a realistic breakdown. Sections 3 and 4 (requirements, non-goals) are taken as a contract and are not reopened. Every trade-off ends in a decision, not in a list of options.

Hardware context verified on the development workstation (WSL2, Ubuntu 26.04): kernel 6.18 with `nf_tables`, `nft_reject`, `br_netfilter` loaded, cgroup v2, systemd active, sub-UIDs already allocated to the user, 24 cores, 31 GB. Podman and nftables are installable from the repositories (podman 5.7, nftables 1.1, netavark 1.16, passt) but **not installed**. Docker Desktop is present on the Windows side but not integrated into this distro, and it must not be (see D1).

## 1. Overall verdict

The framing document is sound on substance: the two regimes, the enforcement points per requirement, the rejection of Codespaces for E10, the "thin portal on top of existing building blocks" stance, the order of the milestones. None of that is called into question.

It falls short on three points, all in section 7, and all in the same direction: it builds a mechanism where a structural property would give the same guarantee for less code.

1. **Network filtering** is conceived as a dynamic per-container nftables policy. An `internal` network without a gateway gives the same guarantee without a single per-session rule.
2. **The Git channel** implements the smart HTTP protocol inside the portal and injects a token into the container. A bare staging repository served by `git http-backend`, authenticated by the container's source address, removes both the protocol to be written and the secret inside the container.
3. **Periodic saving** commits into the student's repository every two minutes. That pollutes their history and answers a risk the persistent volume already covers; the real risk (unsaved buffers, host disk) is handled by the editor's autosave and a host-side snapshot.

It also has two security blind spots (section 4 below): the container reaches the host itself, and the exam workspace must never be seeded from the student's repository.

## 2. Open decisions: trade-offs

### D1. Rootful Podman, `internal` network, no Docker Desktop

**Decision: Podman in privileged (rootful) mode, `--userns=auto`, a dedicated `internal` bridged network, DNS disabled inside the containers.**

The framing document is right about rootless: pasta and slirp4netns move the network stack into user space and make nftables ineffective on that traffic. It is also right about the "privileged engine + user namespaces" compromise. What settles the matter between Docker and Podman is the granularity of the namespace:

- Docker `userns-remap` applies **a single** sub-UID range to all the containers of the daemon. Two students who escape land on the same host UID.
- Podman `--userns=auto` allocates **a distinct range per container**. That is literally the requirement of section 7 ("a distinct user namespace per container"). Docker does not satisfy it.

On filtering, the framing document overestimates the work. A network created with `podman network create --internal --disable-dns --gateway <ip>` has neither a default route nor NAT: a process inside the container reaches **nothing** outside the bridge's subnet, by construction. The allow list then boils down to whatever listens on the bridge IP on the host side, that is, the portal. **Verified on 2026-09-17 on this workstation** (Podman 5.7, netavark): with the explicit gateway, the bridge carries the host-side address, an HTTP server bound to that address answers the container, and `1.1.1.1` is unreachable for lack of a route. Without `--gateway`, an `internal` network assigns **no** address to the bridge and the host is unreachable: the option is mandatory, not cosmetic. Two **fixed** nftables rules remain, never modified per session:

1. Forbid container ↔ container traffic on the bridge. Without it, two students communicate over the network during an exam; measured as open on this workstation, **including over link-local IPv6** (`fe80::/64`), which Podman assigns even on a network without IPv6. **Correction after P2**: the nftables `bridge` family does not exist in the WSL kernel (module absent). The rule is therefore written in the `inet` family, `forward` hook, `iifname cs0 oifname cs0 drop`, with `br_netfilter` loaded and `bridge-nf-call-iptables` and `-ip6tables` set to 1; that is the mechanism of `docker --icc=false`, and `inet` covers both protocols. The `bridge` variant is shipped separately for the production VM. The network is created with `--interface-name cs0` so that the rules can name a stable interface.
2. Restrict what the bridge can reach on the host (family `inet`, `input` hook, the bridge's `iifname`) to the Git proxy port alone. See blind spot 4.1.

DNS disappears: `--dns=none` and `--add-host portal.internal:<bridge ip>`. No split-view resolver left to exploit, and the DNS exfiltration vector of section 9 no longer exists. A measured detail: without `/etc/resolv.conf`, libc falls back to `127.0.0.1` and waits five seconds per failed resolution; the image therefore ships a `resolv.conf` with no `nameserver` and `options timeout:1 attempts:1`, and the failure takes two milliseconds.

**Bridge lifecycle.** netavark creates the bridge when the first container joins the network and deletes it when the last one leaves. A portal that wants to bind to `10.77.0.254` before the first session would fail. Decision P2: a permanent **anchor container** (`codespace-anchor`, alpine in `sleep infinity`, all capabilities dropped, read-only root) keeps the bridge and the address alive. The alternative, listening on `0.0.0.0` and filtering in the application, would expose the Git port on every interface and would require one more nftables rule for less safety. The portal's garbage collector must ignore that container (label `heig-codespace.role=anchor`).

The framing document's arbitration criterion is the right one and becomes the acceptance test of proof C: from the container, `curl` to the bridge IP on the Git port succeeds; to the bridge on any other port, to 1.1.1.1, to another container, and any DNS resolution fail.

Two pitfalls on the development workstation:

- **Docker Desktop is disqualified.** Its daemon runs in another WSL distro; the nftables rules laid down here would not apply to its bridges, and `--userns=auto` does not exist. The project must live on a native Podman installed inside this Ubuntu.
- The portal must talk to the rootful socket (`/run/podman/podman.sock`). Whoever controls that socket is root; the portal is therefore **the** privileged component of the host, and that must be owned rather than hidden behind a cosmetic sudo.
- **The `podman` binary stays in local rootless mode as long as `--remote` is not passed.** `CONTAINER_HOST` alone is ignored. Half a day of tests was lost on 2026-09-17 measuring a pasta network while believing it was the rootful bridge. The engine module always invokes `podman --remote --url unix:///run/podman/podman.sock`, and the workstation declares a default connection (`podman system connection add --default`). Details in [setup-poste.md](setup-poste.md).

### D2. gVisor: not in v1, decision deferred to the first real exam session

The legal argument is real but premature. gVisor adds ptrace compatibility to be proven, a second runtime configuration to maintain and to test before every exam, on a system that has not yet run a single lab session. The baseline hardening (per-container userns, no capabilities, seccomp, read-only root, no network) already sets the bar at a kernel exploit, outside the threat model of section 9.

The engine module does expose the runtime as an option (`EngineOptions.runtime` in `src/engine/index.ts`, passed straight through as `--runtime`), but **nothing wires it to configuration yet**: there is no environment variable for it, so switching to gVisor would still be a code change today. Wiring it is all that is asked of the engine in v1.

### D3. Repository provisioning: consume heig-classroom, reimplement nothing

The framing document hesitates between reimplementing and consuming GitHub Classroom. It forgets that [heig-classroom](/home/ycr/heig-classroom) already does exactly that: creating student repositories from a template, mapping institutional identity ↔ GitHub, a GitHub App installed on the organisation, account linking. The codespace portal does not create repositories; it receives the target repository URL and pushes to it.

For the test portal, the target repository is a line in the assignment file. For production, it is a request to heig-classroom (or a shared table if the two end up in the same process, see section 6).

### D4. SEB Server: ignored

SEB Server is a Spring stack plus a relational database plus a web interface, sized for a university-scale examination service. For twenty workstations and one SEB configuration per assignment, generating a `.seb` file and serving a `sebs://` link takes about a hundred lines. The real-time monitoring it brings is already in the portal's active sessions dashboard. Position 1 of the framing document. To be reopened only if the institution already operates a SEB Server.

### D5. Concurrent session: resume in both modes, alert in exam mode

code-server is designed for several tabs on the same server; "resume the existing session" is free, it is the behaviour of a second tab on a VS Code Web. Refusing would require tracking the websocket connections and killing one of them, with a real risk of refusing the legitimate student whose tab has crashed.

Decision: one live session per (student, assignment) pair. Any new opening returns to it. In exam mode, if a request arrives from a **different client address** than the one of the initial SEB verification, the proxy refuses and the teacher dashboard displays an alert. The semantics are the same in both modes; only the provenance check differs, which is already the case.

### D6. One directory per (student, assignment) pair, bind-mounted

The "multiplies the objects" dilemma disappears if the volume is a host directory `/srv/codespace/volumes/<student>/<assignment>/` rather than a named volume of the engine. The backup is an `rsync` of the tree; inspection by the administrator is an `ls`. The container mounts only the `work/` subdirectory; the staging repository and the snapshots live next to it, invisible to the student (section 3).

A concrete pitfall for agents: with `--userns=auto`, the container's UID is mapped onto a different host range at every start. The mount must use Podman's `:U` option (recursive chown to the mapped range) or the portal must pin the mapped UID per session with `--uidmap`. That is the kind of detail that costs a day if it is discovered at milestone 3.

Pedagogy: isolation per assignment in exam mode is desirable (the student does not consult their lab work). In lab mode, a teacher who wants a shared space across assignments solves it with a single "semester" assignment. No option to expose.

### D7. Remove the network list from the teacher interface

Yes, without reservation. With the `internal` network and the documentation mirrors served by the portal, the only destination the container reaches is the portal, and that is not a setting but a property. A list of exceptions, should it become necessary (a teacher's test server), is an attribute **of an image or of an administrator profile**, set in a configuration file on the host, not a field of the assignment form.

### D8. Stack: heig-classroom's, no discussion

The framing document says "no strong constraint" and proposes choosing on library quality. The three needs it cites are covered in Node: `@fastify/http-proxy` relays websockets, `git http-backend` is driven as CGI from any language, and the engine is driven through its command line or its REST API. No stack wins technically; what wins is **reuse**:

- Fastify 5, strict TypeScript, Zod, Drizzle, `openid-client`, `octokit`: already in production in heig-classroom, with ADRs and conventions.
- The development Keycloak realm, the GitHub App flow and its account linking: reusable as they are.
- The maintainer is the same and the code will largely be written by assistants: a single language and a single style matter more than anything.

Two divergences accepted for the test portal:

- **SQLite through Drizzle** rather than PostgreSQL: one file, zero service, backup by copy. Drizzle isolates the choice; moving to Postgres is mechanical if the two portals merge.
- **No React in v0.** A few HTML pages served by Fastify are enough for the student path and for the teacher dashboard of milestone 1. The rich interface comes at milestone 4, when we know what it has to show.

Driving the engine: the **`podman` command line** wrapped in a single module (`engine.ts`), with `--format json` output. Transparent, debuggable by hand, and the libpod API brings nothing for twenty containers. The module is the only place that knows about Podman.

## 3. Section 7: three substantive simplifications

### 3.1 Git channel: a staging repository instead of a protocol to write

The framing document proposes that the portal implement the smart Git HTTP protocol and relay to GitHub, with a session token injected into the container's Git configuration. Three objections.

A session token inside the container **is** a secret inside the container. Short-lived and revocable, but exfiltrable while it lives, which contradicts the title of the section ("no secret inside the container"). On a bridge managed by the portal, with inter-container traffic blocked, **the source IP address identifies the session** reliably. The portal knows which IP it gave to which container. The remote is `http://portal.internal:<port>/git/<session>` and the proxy checks that the request comes from that session's IP. Zero secret, zero revocation.

Implementing receive-pack is pointless: `git http-backend` has been doing it, as CGI, for twenty years. The portal sets the environment variables (`PATH_INFO`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `GIT_PROJECT_ROOT`), pipes the body, reads back the CGI headers. Sixty lines of Node, no protocol.

Relaying directly to GitHub makes the submission of an exam depend on GitHub's availability at the moment of the push. A **bare staging repository** per (student, assignment) pair, on the host next to the volume, decouples them: the student's push lands locally in a few milliseconds and constitutes the timestamped proof of submission (the framing document's `PushEvent`), then a background job relays to GitHub with the installation token, with retry on error. The token never leaves the portal's memory.

Chosen architecture:

```text
container ──push──▶ portal:/git/<session>  (auth by source IP)
                       │  git http-backend  →  volumes/<s>/<a>/staging.git
                       │  records PushEvent (ref, sha, timestamp)
                       └─ relay job ──push (installation token)──▶ GitHub
```

Welcome side effects: the staging repository is a second copy of the pushed history (E15, E17), and it answers the section 13 question about `upload-pack` (3.2).

### 3.2 Refusing upload-pack does not protect what it thinks it protects

The framing document forbids cloning and fetching in order to close "the path by which a student would introduce an extension file". Two flaws in the reasoning.

First, the path is not closed: the framing document plans a clone **at provisioning time**, from the student's repository. Everything the student pushed from home before the exam (a `.vsix`, a cheat sheet, a solution) lands in the container. See blind spot 4.2.

Second, the presence of a `.vsix` file in the container is only dangerous if installing it is possible. Now, the student has a terminal and can invoke the code-server binary with `--install-extension`. The only barrier that holds is for the **extensions directory to be read-only** (it is on the read-only root) and for the user data directory not to allow creating a second one. With that, a `.vsix` in the container is an inert file, whether it arrives by pull, by typing it in, or base64-encoded in a commit. E5 is played out in the image, not in the Git proxy.

Decision: `upload-pack` is **allowed** on the staging repository in both modes. What changes between the modes is **what the portal puts into the staging repository**:

- Lab work: a mirror of the student's GitHub repository, synchronised at session start and on demand. The student pulls their own commits made elsewhere. Normal comfort.
- Exam: seeded from the **teacher's template** only, never from the student's repository. During the exam, the teacher can push a fix to the assignment text onto the template; the portal propagates it to the staging repositories; the students run `git pull`. That is exactly the feature the framing document feared losing.

### 3.3 Saving: autosave in the editor, host-side snapshots, no ghost commits

An automatic commit every two minutes on a working branch in the student's repository creates more problems than it solves: it interferes with a merge or a rebase in progress, it confuses a beginner who discovers commits they did not make, and it brings nothing against the two real losses.

The two real losses are: an editor buffer never written to disk, and the disappearance of the host disk. The volume already survives a network outage, a closed tab and the death of the container: that is the point of the "Persistence" section and it is settled.

Decision:

1. `files.autoSave: afterDelay` (one second) enforced in the machine settings of code-server, not modifiable by the student. The buffer no longer exists as a risk.
2. A **host-side ghost repository** (`volumes/<s>/<a>/shadow.git`, work-tree = `work/`), committed every two to three minutes, invisible from the container. It captures the working tree including what the student has not committed, without touching their repository. It settles disputes ("I had written the function, it disappeared") better than a visible branch. **Measured in V1**: the volume belongs to the container's UID range (`:U`); the portal running as uid 1000 reads the tree thanks to umask 022, but a `chmod 600` by the student makes the snapshot fail, reduced then to a logged partial commit. Decision for production: the snapshot is taken by a **root systemd timer**, the portal only declares the active volumes. That is consistent with the fact that the portal must not be able to delete a volume either.
3. Off-host backup of `/srv/codespace/volumes` (rsync or a VM provider snapshot); that is ordinary operations, milestone 5.

### 3.4 Pre-warmed pool: not to be built before measuring

**Measured by P1 on 2026-09-17** on the hardened image (1.5 GB, code-server 4.137): `podman run` returns in 0.18 s, `/healthz` answers in 0.6 to 1.0 s, the workbench page is served in 1 s. The clone from the staging repository is local. The ten-second target is met with an order of magnitude of margin. The pool would complicate the volume ↔ userns pairing and would introduce a class of states ("pre-warmed but not assigned") into the orchestrator. **Decision: no pool.** To be measured again at twenty concurrent sessions at milestone 1; only a degradation by a factor of five would reopen the question.

### 3.5 Hardening: details that matter

- **CAP_SYS_PTRACE is not necessary** for `gdb ./prog`: gdb traces its own children, which Yama at scope 1 (the value on this workstation, and the default on Ubuntu) allows, and the default seccomp profile has permitted `ptrace` since kernel 4.8. It is only needed for `gdb -p <pid>` on a process started from another terminal. Confined by the userns, it is not very dangerous; decision: dropped by default, enableable per image profile if the teacher requires it.
- **`personality`**: the framing document is right. The default profile allows only five values and excludes `ADDR_NO_RANDOMIZE` (0x40000). Without that entry, gdb does not disable ASLR and the addresses change at every run, which ruins a debugging course. The project's seccomp profile is the default `containers-common` profile plus that value, nothing else.
- **Memory**: two gigabytes × twenty = forty on a thirty-two gigabyte machine. Tolerable overcommitment (clangd on a C lab consumes a few hundred megabytes), but setting the limit at 1.5 GB prevents a single `make -j` from triggering the OOM killer on the neighbour.
- **code-server** rather than openvscode-server: active maintenance, and above all the `--disable-file-downloads` and `--disable-file-uploads` options, which do not exist elsewhere (blind spot 4.3). `--auth none` behind the proxy, binding on the container IP only. Gallery neutralised by an empty `EXTENSIONS_GALLERY` in addition to `product.json`.
- **C extensions**: `ms-vscode.cpptools` has a licence that forbids its use outside Microsoft products; it is not on Open VSX. The image embeds `llvm-vs-code-extensions.vscode-clangd` with the `clangd` binary (otherwise the extension tries to download it and fails, network cut off) and `webfreak.debug` for gdb. Both are on Open VSX and installed at build time without incident (P1).
- **Machine settings: not immutable.** P1 could not establish that code-server 4.137 honours the machine scope for the seven settings that are set; a student can therefore modify them from the interface during their session (they come back at the next start, the data directory being a tmpfs). Consequence: `extensions.allowed` and `files.autoSave` are comfort, not barriers. The measured E5 barrier is the read-only extensions directory; the E15 safety net must therefore be the host-side ghost repository (3.3), not only autosave.
- **Two Podman 5.7 constraints discovered**: `--dns=none` is refused together with `--network none` (the script only sets it on a real network); the `/run` and `~/.cache` tmpfs must be mounted `mode=1777` because Podman creates them `root:755` while the container runs as uid 1000, the `uid=`/`gid=` options not being accepted on `--tmpfs`.

## 4. Blind spots of the threat model

### 4.1 The container reaches the host

On an `internal` network the container does not get out, but it reaches **everything that listens on the bridge IP**: the whole portal (teacher interface, OIDC callback), and in development Keycloak, Forgejo, the database. A student in an exam could call the teacher API from their terminal if a token were lying around, or simply probe the services. The framing document does not mention it.

Double counter-measure: the Git surface listens **only** on the bridge IP; the portal's other surfaces listen on the other interfaces. Plus an nftables `input` rule on the bridge that lets only the Git port through. Both, because an address binding can be broken by an environment variable.

### 4.2 The exam workspace seeded from the student's repository

Handled in 3.2. It is the simplest and most likely way around the scheme: prepare at home, push, get it back in the exam. It has to be written into the threat model and into the data model: an assignment in exam mode has a **template** repository as its source and a **target** repository per student, created empty or from the template, never the other way round.

### 4.3 File in and out through the browser

VS Code's explorer accepts drag-and-drop of files from the workstation and offers "Download" on right click. In an exam, that is an inbound channel (a cheat sheet from a USB stick if SEB leaves the file explorer reachable) and an outbound one. Two layers: `allowDownUploads` false in the SEB configuration, and `--disable-file-downloads --disable-file-uploads` in code-server. The clipboard is SEB's business (`enablePrivateClipboard`).

### 4.4 SEB keys in a mixed fleet

The Browser Exam Key depends on the SEB **binary** (platform and version) and on the configuration. A room with Windows and Mac machines produces two BEKs for the same assignment. The data model must carry a **list** of accepted BEKs per assignment, not a scalar, and the teacher procedure must explain where to read them (the SEB configuration tool displays them).

The Config Key, on the other hand, is computed server-side from the generated configuration. The JSON normalisation algorithm (key sorting, exclusion of `originatorVersion`, exact serialisation) is treacherous; the agents must port the reference implementation of the Moodle plugin `quizaccess_seb` rather than reinvent it.

Encrypting the `.seb` file brings nothing to integrity (the Config Key guarantees it) and a password to type creates friction in the room. Decision: unencrypted file in v1.

### 4.5 SEB headers and websockets

The framing document rightly plans to verify on opening and then issue a cookie. It must be said more strongly: there is **no guarantee** that SEB adds its headers to websocket upgrades or to service worker requests. The proxy to code-server must **never** expect a SEB header; it only knows the session cookie, bound to the initial verification and to the client address (D5). Proof B must test precisely that path.

### 4.6 The URL on which SEB computes its hashes

The two SEB headers are `sha256(url + key)` where the URL is the one the browser requested. Behind a TLS front end, the portal reconstructs it; if it reconstructs it from the `Host` or `X-Forwarded-Host` header, the student chooses the URL on which the hash is verified. Decision P4: in production the public origin is a configuration constant (`SEB_PUBLIC_ORIGIN`), nothing the client sends enters the computation.

## 5. Answers to the four questions of section 13

**Is the Git channel without a secret the right answer?** Yes in principle, no in form. The simplest form with equal guarantees is: identification by source IP, `git http-backend` on a local staging repository, asynchronous relay to GitHub by the portal. Less code, no secret in the container, submission independent of GitHub.

**Is refusing upload-pack tenable?** It is neither tenable nor useful. The intended guarantee is held in the image (read-only extensions directory, neutralised gallery). Pulling is allowed, and the exam protection consists in seeding the staging repository from the teacher's template.

**Is not starting from Coder justified?** Yes. What Coder would replace, the orchestrator, amounts to a few hundred lines around `podman run`. What makes the value of the project (SEB verification, Git channel, cut-off network, image settings) would have to be written next to Coder anyway, and the `internal` network would have to be imposed against its default model.

**Is a late teacher interface sustainable?** Yes, because the first teacher is the author of the project. An assignment is a YAML file until the pilot. A non-functional mock-up would teach nothing at n = 1; a lived lab session would.

## 6. Relationship with heig-classroom

The two portals share identity (Switch edu-ID), the GitHub App, the notion of an assignment and the students. The temptation to merge them is legitimate and will be strong. Position for now: **separate repository, identical stack, module boundaries drawn for a later mounting as a Fastify plugin** inside heig-classroom. Concretely: the codespace portal knows GitHub repositories only through a `RepoProvider` interface (YAML file in v0, heig-classroom client afterwards), and its database does not duplicate the student table beyond the institutional identifier and the GitHub login.

Merging now would cost the test portal's iteration speed and would expose heig-classroom's production to a component that drives a container engine as root. Later, when the invariants hold.

## 7. What the agents cannot do

**Proof A** (code-server in SEB's browser, on the platform of the exam room) requires a Windows or macOS workstation with SEB installed. It is a manual test by the author, five minutes, to be done early: open any public test code-server instance from SEB, check the editor, the terminal, and reloading the page. The probability of failure is low (SEB Windows 3 embeds Chromium, SEB macOS WebKit, both run VS Code Web) but a failure changes the project.

**Installing Podman** on this workstation requires a sudo password. Commands to run once, by hand, before launching the agents:

```bash
sudo apt install podman nftables crun netavark aardvark-dns passt uidmap
echo "containers:2147483647:2147483648" | sudo tee -a /etc/subuid /etc/subgid
sudo systemctl enable --now podman.socket
sudo podman info --format '{{.Host.NetworkBackend}} {{.Host.OCIRuntime.Name}}'
```

These commands were run on 2026-09-17; the complete procedure, with the two pitfalls encountered (socket directory recreated as 0700 by tmpfiles, remote mode to be forced), is in [setup-poste.md](setup-poste.md). All the rest of milestone 0 and milestone 1 is done by agents, see [jalon-0.md](jalon-0.md).
