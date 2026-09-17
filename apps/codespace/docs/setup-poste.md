# Installation du poste de développement

Fait le 2026-09-17 sur WSL2, Ubuntu 26.04, noyau 6.18 Microsoft, systemd actif. Valable tel quel pour une VM Ubuntu 24.04 ou 26.04, WSL mis à part.

## Paquets

```bash
sudo apt install -y podman podman-compose crun netavark aardvark-dns passt uidmap nftables git
echo "containers:2147483647:2147483648" | sudo tee -a /etc/subuid /etc/subgid
```

La ligne `containers` est ce qui permet `--userns=auto` : Podman y découpe une plage de 1024 UID par conteneur.

## Socket rootful accessible sans root

```bash
sudo groupadd -f podman
sudo usermod -aG podman "$USER"
sudo mkdir -p /etc/systemd/system/podman.socket.d
printf '[Socket]\nSocketGroup=podman\nSocketMode=0660\n' | sudo tee /etc/systemd/system/podman.socket.d/group.conf
printf 'D! /run/podman 0750 root podman\n' | sudo tee /etc/tmpfiles.d/podman.conf
sudo systemctl daemon-reload
sudo systemctl enable --now podman.socket nftables
```

Puis nouvelle session (le groupe n'est pris qu'à la connexion).

Piège 1 : `/usr/lib/tmpfiles.d/podman.conf` recrée `/run/podman` en `0700 root root` à chaque démarrage. Le socket peut être `root:podman 660`, le répertoire reste infranchissable et l'erreur est un simple "permission denied". La surcharge dans `/etc/tmpfiles.d/` du même nom prime.

## Mode distant

```bash
podman system connection add --default rootful unix:///run/podman/podman.sock
echo "alias podman='podman --remote'" >> ~/.zshrc
```

Piège 2 : le binaire `podman` sous Linux reste en mode **local rootless** même avec `CONTAINER_HOST` défini. Seul `--remote` active le mode distant. Sans lui, `podman run` crée des conteneurs rootless dans un espace de noms réseau privé avec pasta, tire les images dans un stockage séparé, et affiche un avertissement sur `/` non partagé. Tous les tests réseau y sont faux. Le module `engine/` du portail passe donc toujours `--remote --url`.

## Vérification

```bash
podman info --format 'rootless={{.Host.Security.Rootless}} backend={{.Host.NetworkBackend}} runtime={{.Host.OCIRuntime.Name}}'
# attendu : rootless=false backend=netavark runtime=crun
```

Test du réseau clos, reproduit et vert le 2026-09-17 :

```bash
podman network create --internal --disable-dns --subnet 10.77.1.0/24 --gateway 10.77.1.254 cstest
podman run -d --rm --name cstest1 --network cstest --dns=none docker.io/library/alpine:3.20 sleep 600
ip -br -4 addr show dev "$(podman network inspect cstest --format '{{.NetworkInterface}}')"   # 10.77.1.254/24
sudo python3 -m http.server 9418 --bind 10.77.1.254 --directory /tmp &
podman exec cstest1 wget -T 3 -qO- http://10.77.1.254:9418/ >/dev/null && echo "hote: OK"
podman exec cstest1 wget -T 3 -qO- http://1.1.1.1/ || echo "sortie: close"
sudo pkill -f 'http.server 9418'; podman rm -f cstest1; podman network rm cstest
```

Mesuré aussi : deux conteneurs du même réseau `internal` se joignent (à bloquer par nftables, tâche P2) ; `--dns=none` supprime toute résolution ; deux conteneurs `--userns=auto` ont des plages d'UID hôte différentes (`2147483647` et `2147484671`).

## WSL uniquement

`/etc/wsl.conf` doit garder une seule section `[boot]` :

```ini
[boot]
systemd=true
command = mount --make-rshared /

[user]
default=ycr
```

Docker Desktop, s'il est installé côté Windows, ne doit pas être intégré à cette distro : son démon vit ailleurs et rien de ce qui précède ne s'y applique.
