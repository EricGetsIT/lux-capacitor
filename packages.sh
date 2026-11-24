#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Source after os-release to select the install command and package lists.
case ${ID:-} in
    ubuntu|debian|fedora|arch|opensuse*) distro=$ID ;;
    *)
        distro=
        read -ra parents <<< "${ID_LIKE:-}"
        for parent in "${parents[@]}"; do
            case $parent in
                ubuntu|debian|arch|suse|opensuse*) distro=$parent; break ;;
            esac
        done ;;
esac

gnome=(gnome-settings-daemon)
case $distro in
    ubuntu|debian)
        package_install=(apt-get install -y)
        common=(iio-sensor-proxy upower python3 python3-gi dconf-cli libglib2.0-bin gjs)
        kde=(gir1.2-adw-1 gir1.2-gtk-4.0) ;;
    fedora)
        package_install=(dnf install -y)
        common=(iio-sensor-proxy upower python3 python3-gobject dconf glib2 gjs)
        kde=(libadwaita gtk4) ;;
    arch)
        package_install=(pacman -S --needed --noconfirm)
        common=(iio-sensor-proxy upower python python-gobject dconf glib2 gjs)
        kde=(libadwaita gtk4) ;;
    opensuse*|suse)
        package_install=(zypper --non-interactive install)
        common=(iio-sensor-proxy upower python3 python3-gobject dconf glib2-tools gjs)
        kde=(typelib-1_0-Adw-1 typelib-1_0-Gtk-4_0) ;;
    *)
        echo "This installer supports Ubuntu, Debian, Fedora, Arch and openSUSE. Found: ${ID:-unknown distribution}. No changes made."
        return 1 ;;
esac
