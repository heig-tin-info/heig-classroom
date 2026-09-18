# Development workstation installation

Done on 2026-09-17 on WSL2, Ubuntu 26.04, Microsoft kernel 6.18, systemd active. Valid as it stands for an Ubuntu 24.04 or 26.04 VM, WSL aside.

## Packages

```bash
sudo apt install -y podman podman-compose crun netavark aardvark-dns passt uidmap nftables git
echo "containers:2147483647:2147483648" | sudo tee -a /etc/subuid /etc/subgid
```

The `containers` line is what makes `--userns=auto` possible: Podman carves out a range of 1024 UIDs per container from it.

## Rootful socket reachable without root

```bash
sudo groupadd -f podman
sudo usermod -aG podman "$USER"
sudo mkdir -p /etc/systemd/system/podman.socket.d
printf '[Socket]\nSocketGroup=podman\nSocketMode=0660\n' | sudo tee /etc/systemd/system/podman.socket.d/group.conf
printf 'D! /run/podman 0750 root podman\n' | sudo tee /etc/tmpfiles.d/podman.conf
sudo systemctl daemon-reload
sudo systemctl enable --now podman.socket nftables
```

Then open a new session (the group is only picked up at login).

Pitfall 1: `/usr/lib/tmpfiles.d/podman.conf` recreates `/run/podman` as `0700 root root` at every boot. The socket may well be `root:podman 660`, the directory stays impassable and the error is a plain "permission denied". The override of the same name in `/etc/tmpfiles.d/` takes precedence.

## Remote mode

```bash
podman system connection add --default rootful unix:///run/podman/podman.sock
echo "alias podman='podman --remote'" >> ~/.zshrc
```

Pitfall 2: the `podman` binary on Linux stays in **local rootless** mode even with `CONTAINER_HOST` set. Only `--remote` turns on remote mode. Without it, `podman run` creates rootless containers in a private network namespace with pasta, pulls images into a separate storage, and prints a warning about `/` not being shared. Every network test there is wrong. The portal's `engine/` module therefore always passes `--remote --url`.

## Verification

```bash
podman info --format 'rootless={{.Host.Security.Rootless}} backend={{.Host.NetworkBackend}} runtime={{.Host.OCIRuntime.Name}}'
# expected: rootless=false backend=netavark runtime=crun
```

Closed network test, reproduced and green on 2026-09-17:

```bash
podman network create --internal --disable-dns --subnet 10.77.1.0/24 --gateway 10.77.1.254 cstest
podman run -d --rm --name cstest1 --network cstest --dns=none docker.io/library/alpine:3.20 sleep 600
ip -br -4 addr show dev "$(podman network inspect cstest --format '{{.NetworkInterface}}')"   # 10.77.1.254/24
sudo python3 -m http.server 9418 --bind 10.77.1.254 --directory /tmp &
podman exec cstest1 wget -T 3 -qO- http://10.77.1.254:9418/ >/dev/null && echo "hote: OK"
podman exec cstest1 wget -T 3 -qO- http://1.1.1.1/ || echo "sortie: close"
sudo pkill -f 'http.server 9418'; podman rm -f cstest1; podman network rm cstest
```

Also measured: two containers on the same `internal` network reach each other (to be blocked by nftables, task P2); `--dns=none` removes all name resolution; two `--userns=auto` containers get different host UID ranges (`2147483647` and `2147484671`).

## WSL only

`/etc/wsl.conf` must keep a single `[boot]` section:

```ini
[boot]
systemd=true
command = mount --make-rshared /

[user]
default=ycr
```

Docker Desktop, if it is installed on the Windows side, must not be integrated into this distro: its daemon lives elsewhere and none of the above applies to it.
