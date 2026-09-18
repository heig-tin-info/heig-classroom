# infra/net — closed `codespace` network (milestone 0, task P2)

Three scripts and two rule files:

| file | role |
| --- | --- |
| `common.sh` | shared constants + the `pd()` function (`podman --remote --url unix:///run/podman/podman.sock`) |
| `setup.sh` | creates the network, starts the anchor, loads the nft tables. Idempotent. `sudo` required for the nft part |
| `teardown.sh` | removes tables, anchor, network |
| `test.sh` | P2 acceptance assertions (`PASS` / `FAIL` / `BLOCKED`), exits non-zero if there is a `FAIL` |
| `../nft/codespace.nft` | the two fixed rules, `inet` family |
| `../nft/codespace-bridge.nft` | the same ICC rule in the `bridge` family, defence in depth, optional |

## Decision: anchor container, no binding on 0.0.0.0

With netavark, the bridge of a Podman network only exists as long as a container
is attached to it: it is created at the first `podman run --network codespace`
and **deleted** when the last container leaves (checked on 2026-09-17: `ip addr
show dev cs0` goes from `10.77.0.254/24` to "Device does not exist" after the
`podman rm` of the last container). The portal, for its part, must bind to
`10.77.0.254:9418` to offer the Git channel, and it starts before any session.
Two ways out: permanently keep a container on the network so that the bridge and
its address exist, or bind the Git server on `0.0.0.0` and rely on application
filtering plus nftables so that it only answers on the bridge.

The second way out is discarded because it destroys the defence in depth that
analyse.md §4.1 explicitly asks for: "the Git surface listens **only** on the
bridge IP […] and an nftables `input` rule on the bridge lets nothing but the
Git port through. Both, because an address binding can be undone by an
environment variable". Binding `0.0.0.0` reverses the argument: port 9418
becomes exposed on every interface of the host (under WSL, the interface towards
the Windows host and therefore the school network), and the nft rule becomes the
only barrier instead of the second one; it would also need an extra "refuse 9418
everywhere except on cs0" rule, that is, more nft surface for less safety. The
cost of the anchor is on the contrary negligible: an `alpine:3.20` in `sleep
infinity`, 32 MiB memory limit, 16 processes, no capabilities, read-only root,
on a network where the ICC rule prevents it from talking to the students'
containers anyway. It also makes the interface name `cs0` and the address
`10.77.0.254` permanent, which every nft rule depends on. **Decision: anchor**,
created and restarted by `setup.sh`, named `codespace-anchor`, labelled
`heig-codespace.role=anchor`.

Consequences to honour elsewhere: the session garbage collector (`src/sessions/`)
must ignore containers carrying that label; the reconciliation must not take it
for an orphan session; `teardown.sh` is the only place that removes it.
`--restart always` is set, but it is not enough after a host reboot if
`podman-restart.service` is not enabled: `setup.sh` at start-up is the normal
mechanism.

## Living alongside netavark

netavark puts its own chains in `table inet netavark` (priority `filter`, 0).
Our two base chains are in `table inet codespace` at priority `filter - 10`:
they see the packet first. That is not what makes the rules correct — in
nftables a `drop` in any chain of a hook is terminal for the packet, whereas an
`accept` is terminal only within its own chain — but it avoids depending on the
load order.

Both chains have `policy accept` and all their rules are guarded by
`iifname "cs0"` / `oifname "cs0"`. The default `podman` bridge, the
`infra_default` network of `compose.dev.yml` (Keycloak, Forgejo) and any other
Podman network are therefore never touched. `teardown.sh` only removes the
tables named `codespace`.

TODO(verify) netavark 1.x / nftables 1.1.6: re-read `sudo nft list table inet
netavark` once `setup.sh` has run and confirm priority 0; reading the ruleset
requires root, and it could not be done at the time of writing.

## `bridge` family unavailable on this kernel: the equivalent chosen

analyse.md D1 prescribes the ICC rule in the `bridge` family with `meta ibrname`.
Measured on this workstation (WSL2 kernel `6.18.33.2-microsoft-standard`): the
`bridge` family does not exist. `nf_tables_bridge.ko` is absent from
`/lib/modules/$(uname -r)` as well as from `modules.builtin`, and
`modinfo nf_tables_bridge` answers "Module not found"; only the old `ebt_*`
modules are there. A `bridge` table passes the `nft` parser and is then refused
by the kernel at load time.

Equivalent implemented, in `codespace.nft`: `br_netfilter` makes bridged IP
packets cross the ordinary IP hooks, with `iifname`/`oifname` equal to the
bridge (the veth port is only visible to the `physdev` match). The rule
`iifname "cs0" oifname "cs0" drop` in `inet`/`forward` is exactly the mechanism
of `docker --icc=false`. `setup.sh` loads the module and forces
`net.bridge.bridge-nf-call-iptables=1` and `-ip6tables=1`, without which the
rule would be silently inoperative. `codespace-bridge.nft` keeps the
`bridge`-family variant: `setup.sh` loads it as well if the kernel supports it
(an ordinary Ubuntu VM), and settles for the `inet` table otherwise. It is never
needed for the test to be green.

Host ↔ container traffic does not go through `forward` (the address
`10.77.0.254` is carried by `cs0`, so it is local input/output): the ICC rule
does not cut off the portal proxy to code-server. `test.sh` checks this
explicitly.

### IPv6 link-local: a real hole, covered by the same rule

Containers get a `fe80::/64` address even on a network without IPv6. Checked on
2026-09-17: `wget http://[fe80::…%eth0]:8080/` from one container to the other
**succeeds** as long as the ICC rule is not in place. The `inet` family covers
IPv4 and IPv6, so the single rule is enough — provided that
`bridge-nf-call-ip6tables` is 1, which `setup.sh` enforces. `test.sh` has an
extra assertion for that, off the milestone-0 list.

## Fallback if the ICC rule turns out to be inoperative

Milestone-0 P2 allows a fallback and sets the budget: no more than half a day on
the rule. Fallback: **one `internal` Podman network per session**, that is,
`podman network create --internal --disable-dns --subnet 10.77.<n>.0/24
--gateway 10.77.<n>.254 --interface-name cs<n> codespace-<sessionId>`, created
when the session starts and destroyed when it stops. Two students are then never
on the same bridge and the isolation no longer depends on any filtering rule.
What it costs: the `input` rule remains indispensable and becomes
session-dependent (one `iifname` per bridge), which violates the "no per-session
rule" of invariant 2 — it would have to be rewritten as `iifname "cs*"`
(interface-name wildcard, supported by nftables) to stay fixed; a `/24`
addressing plan per session is needed, hence a ceiling on simultaneous sessions;
creating and destroying the network adds to session start-up time and to the
reconciliation after a portal crash; and the anchor container becomes useless
for sessions but stays necessary for the bridge the portal listens on. An
intermediate variant, not chosen for lack of a way to test it without root,
would be port isolation of the Linux bridge itself (`bridge link set dev <veth>
isolated on`), which blocks traffic between isolated ports without nftables —
but it is by definition set per session, on an unstable veth name, and would
require a netavark plugin.

## State

Run with root on the development workstation, milestone-0 P2 closed:

- network `codespace` created and conformant: `--internal --disable-dns --subnet
  10.77.0.0/24 --gateway 10.77.0.254 --interface-name cs0` (the
  `--interface-name` option does exist in Podman 5.7);
- anchor `codespace-anchor` started, `cs0` carries `10.77.0.254` permanently;
- nftables rules loaded;
- `sudo infra/net/test.sh`: **11 PASS, 0 FAIL, 0 BLOCKED** (9 assertions plus the
  2 regressions), as recorded in [docs/jalon-0.md](../../docs/jalon-0.md).

`test.sh` run without root cannot read the nftables ruleset; it therefore does
not claim to know the state of the table and marks the assertions that depend on
it `BLOCKED` (never `FAIL`). An assertion that **passes** is still a proof: the
observed behaviour is enough. Only the two regressions (remove each rule and
check that the matching assertion falls) require root from end to end, since
they reload the table.
