#!/bin/sh
# Entrypoint of the c-dev student image.
# The root is read-only; the user-data-dir lives on the /run tmpfs.
set -eu

UDD=/run/code-server
SETTINGS=/etc/code-server/settings.json

mkdir -p "$UDD/User" "$UDD/Machine" "$UDD/logs"
cp "$SETTINGS" "$UDD/User/settings.json"
cp "$SETTINGS" "$UDD/Machine/settings.json"

# code-server writes a default config.yaml into $XDG_CONFIG_HOME;
# /home/student is read-only, so we send it to the /run tmpfs.
# Deliberately local to this script: the student's shell keeps the default
# values, so their --install-extension does aim at a read-only extensions
# directory.
XDG_CONFIG_HOME="$UDD/xdg-config"
export XDG_CONFIG_HOME
mkdir -p "$XDG_CONFIG_HOME/clangd"
# clangd inherits this XDG_CONFIG_HOME: without this copy it would read no
# configuration and fall back on its defaults.
cp /etc/clangd/config.yaml "$XDG_CONFIG_HOME/clangd/config.yaml"

# Extension gallery neutralised: no online installation is possible.
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
