#!/bin/sh
# Point d'entree de l'image etudiante c-dev.
# La racine est en lecture seule ; le user-data-dir vit sur le tmpfs /run.
set -eu

UDD=/run/code-server
SETTINGS=/etc/code-server/settings.json

mkdir -p "$UDD/User" "$UDD/Machine" "$UDD/logs"
cp "$SETTINGS" "$UDD/User/settings.json"
cp "$SETTINGS" "$UDD/Machine/settings.json"

# code-server ecrit un config.yaml par defaut dans $XDG_CONFIG_HOME ;
# /home/student est en lecture seule, on le renvoie sur le tmpfs /run.
# Volontairement local a ce script : le shell de l'etudiant garde les
# valeurs par defaut, donc son --install-extension vise bien un repertoire
# d'extensions en lecture seule.
XDG_CONFIG_HOME="$UDD/xdg-config"
export XDG_CONFIG_HOME
mkdir -p "$XDG_CONFIG_HOME/clangd"
# clangd herite de ce XDG_CONFIG_HOME : sans cette copie il ne lirait aucune
# configuration et retomberait sur ses valeurs par defaut.
cp /etc/clangd/config.yaml "$XDG_CONFIG_HOME/clangd/config.yaml"

# Galerie d'extensions neutralisee : aucune installation en ligne possible.
EXTENSIONS_GALLERY='{"serviceUrl":"","itemUrl":"","resourceUrlTemplate":""}'
export EXTENSIONS_GALLERY

[ -d /work ] || mkdir -p /work

exec code-server \
  --auth none \
  --bind-addr 0.0.0.0:8080 \
  --disable-file-downloads \
  --disable-file-uploads \
  --disable-workspace-trust \
  --disable-update-check \
  --disable-getting-started-override \
  --extensions-dir /opt/code-server/extensions \
  --user-data-dir /run/code-server \
  /work
