#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
trap 'result=$?; if (( result != 0 )); then printf "\nInstallation stopped. Read the message above for the reason.\n"; fi; if [[ -t 0 ]]; then read -r -p "Press Enter to close... " || true; fi' EXIT
if (( EUID == 0 )); then
    echo 'Open this installer as your normal desktop user, without sudo.' >&2
    exit 1
fi
unset ID ID_LIKE
# Tests can point LUX_OS_RELEASE at a temporary os-release file.
source "${LUX_OS_RELEASE:-/etc/os-release}"
source "$base/packages.sh"
echo 'LUX CAPACITOR — guided installation'
gnome_version=$(gnome-shell --version 2>/dev/null) || gnome_version=
plasma_version=$(plasmashell --version 2>/dev/null) || plasma_version=
desktops=
setups=()
packages=("${common[@]}")
if [[ $gnome_version =~ GNOME\ Shell\ 5[01]([.]|$) ]]; then
    desktops=$gnome_version
    setups+=(setup.sh)
    packages+=("${gnome[@]}")
fi
if [[ $plasma_version =~ ^plasmashell[[:space:]]+([0-9]+)\.([0-9]+)(\.|$) ]] &&
    (( BASH_REMATCH[1] > 6 || (BASH_REMATCH[1] == 6 && BASH_REMATCH[2] >= 2) )); then
    desktops+="${desktops:+ and }KDE Plasma ${plasma_version#*[[:space:]]}"
    setups+=(setup-kde.sh)
    packages+=("${kde[@]}")
fi
if [[ -z $desktops ]]; then
    echo "This bundle needs GNOME Shell 50 or 51, or KDE Plasma 6.2 or newer. Found: ${gnome_version:-no GNOME Shell}, ${plasma_version:-no Plasma}. No changes made."
    exit 1
fi
command -v sudo >/dev/null || { echo 'Install sudo before running this installer.' >&2; exit 1; }
echo "Lux Capacitor will be installed for $desktops."
echo 'It will install required packages and set up sensor recovery after sleep or a service crash.'
echo 'Your password may be requested. Nothing appears while you type it.'
read -r -p 'Continue? [y/N] ' answer
[[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || exit 0
if [[ ${package_install[0]} == apt-get ]]; then sudo apt-get update; fi
sudo "${package_install[@]}" "${packages[@]}"
for setup in "${setups[@]}"; do bash "$base/$setup"; done
echo "Finished installing Lux Capacitor for $desktops. Log out and back in. Then test in bright and dim light, and after sleep."
echo 'Both Auto controls start on for a new installation. Existing brightness preferences are preserved.'
