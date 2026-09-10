#!/usr/bin/env bash
# Builds wpa_supplicant from source with 802.11ax/be (disable_he/disable_eht)
# support and installs it as the system wpa_supplicant, so connect_wifi's
# max_standard=ac/ax/be actually caps the negotiated standard instead of
# silently no-op'ing (wpa_cli set_network returning FAIL for those network
# fields) - the stock Raspberry Pi OS package is often built without
# CONFIG_HE_OVERRIDES/CONFIG_IEEE80211BE even at wpa_supplicant 2.10+, where
# those fields exist in the protocol but not in that particular build.
#
# Run this ON the Pi (not the controller) as the pi user with sudo access.
# Safe to re-run: rebuilds from a clean checkout each time and only backs up
# the live binary once (a pre-existing .bak from a previous run is kept, not
# overwritten, so it always points at the real original stock binary).
set -euo pipefail

BUILD_DIR="${WPA_BUILD_DIR:-$HOME/wpa_supplicant-build}"
HOSTAP_REPO="https://w1.fi/hostap.git"
# Network config fields this build needs enabled that aren't always on in a
# stock distro package - see wpa_supplicant/config_ssid.h/config.c for the
# #ifdef guarding each one. CONFIG_IEEE80211BE requires CONFIG_IEEE80211AX;
# disable_he specifically needs CONFIG_HE_OVERRIDES on top of that (a
# separate guard from CONFIG_IEEE80211AX, easy to miss).
#
# CONFIG_HT_OVERRIDES (disable_ht) and CONFIG_VHT_OVERRIDES (disable_vht)
# are NOT in hostap's own defconfig despite being older/more basic than the
# HE/EHT ones above - the stock Raspberry Pi OS package has them built in
# (that's the only reason the pre-rebuild binary could cap to "n"/"legacy"
# at all), but a plain `cp defconfig .config` silently drops them. Missing
# on a first pass here: the rebuild fixed ac/ax capping but broke n/legacy
# in the same swap, since disable_vht/disable_ht started returning FAIL
# where they'd previously returned OK.
REQUIRED_CONFIG_FLAGS=(
    CONFIG_DRIVER_NL80211=y
    CONFIG_CTRL_IFACE=y
    CONFIG_BACKEND=file
    CONFIG_HT_OVERRIDES=y
    CONFIG_VHT_OVERRIDES=y
    CONFIG_IEEE80211AX=y
    CONFIG_HE_OVERRIDES=y
    CONFIG_IEEE80211BE=y
)

echo "==> Installing build dependencies"
sudo apt update
sudo apt install -y git build-essential pkg-config libssl-dev libdbus-1-dev \
    libnl-3-dev libnl-genl-3-dev libnl-route-3-dev

echo "==> Fetching hostap source into $BUILD_DIR"
if [[ -d "$BUILD_DIR/.git" ]]; then
    git -C "$BUILD_DIR" fetch --depth 1 origin master
    git -C "$BUILD_DIR" reset --hard origin/master
else
    rm -rf "$BUILD_DIR"
    git clone --depth 1 "$HOSTAP_REPO" "$BUILD_DIR"
fi

cd "$BUILD_DIR/wpa_supplicant"
cp defconfig .config

echo "==> Enabling required .config flags"
for flag in "${REQUIRED_CONFIG_FLAGS[@]}"; do
    name="${flag%%=*}"
    # Replace a commented/disabled/differently-valued line for this flag if
    # one exists, otherwise append it fresh - defconfig ships most of these
    # commented out (# CONFIG_X=y) rather than absent entirely.
    if grep -q "^#\?\s*${name}=" .config; then
        sed -i "s/^#\?\s*${name}=.*/${flag}/" .config
    else
        echo "$flag" >> .config
    fi
done

# A correct .config (confirmed by grep) has still produced a binary missing
# disable_he on a `make clean; make -j$(nproc)` in practice, for reasons
# that didn't reproduce on an immediate rebuild from the identical .config -
# something about make's dependency tracking not fully invalidating every
# object file `make clean` should have removed. Since that's not understood
# well enough to prevent outright, this builds, verifies with `strings`, and
# - only on failure - rebuilds exactly once more before giving up, which is
# what actually recovered from it by hand. A second consecutive failure is
# treated as a real config/Makefile problem, not a fluke, and dumps the
# actual compiler flags used for config.c (the file disable_he/disable_eht
# live in) so it's diagnosable without repeating this whole investigation.
build_and_verify() {
    echo "==> Building (this takes a few minutes on a Pi)"
    make clean
    make -j"$(nproc)"

    echo "==> Verifying the build actually has the fields we need"
    for field in disable_ht disable_vht disable_he disable_eht; do
        if ! strings wpa_supplicant | grep -qw "$field"; then
            return 1
        fi
    done
    return 0
}

if ! build_and_verify; then
    echo "==> Verification failed after the first build - rebuilding once more from a clean tree before giving up" >&2
    if ! build_and_verify; then
        echo "ERROR: disable_ht/disable_vht/disable_he/disable_eht still missing after two clean rebuilds - a required .config flag is genuinely missing/misconfigured (not just a stale-build fluke). Actual compiler flags used for config.c:" >&2
        make clean >/dev/null
        make V=1 2>&1 | grep "config\.c" | grep -o -- '-DCONFIG[A-Z0-9_]*' | sort -u >&2
        echo "Compare that list against REQUIRED_CONFIG_FLAGS at the top of this script and .config's actual contents. Aborting before install." >&2
        exit 1
    fi
fi

WPA_PATH="$(command -v wpa_supplicant)"
if [[ ! -f "${WPA_PATH}.bak" ]]; then
    echo "==> Backing up stock binary to ${WPA_PATH}.bak"
    sudo cp "$WPA_PATH" "${WPA_PATH}.bak"
else
    echo "==> ${WPA_PATH}.bak already exists, leaving it as-is"
fi

echo "==> Installing new binary to $WPA_PATH"
sudo install -m 755 wpa_supplicant "$WPA_PATH"

# apt won't know this file was replaced outside dpkg - a future `apt
# upgrade` of wpasupplicant would silently overwrite it back to stock.
sudo apt-mark hold wpasupplicant

echo "==> Restarting wpa_supplicant processes and pi-agent"
sudo pkill wpa_supplicant || true
sudo systemctl restart pi-agent

echo "==> Done. Verifying the installed binary:"
strings "$WPA_PATH" | grep -w disable_ht
strings "$WPA_PATH" | grep -w disable_vht
strings "$WPA_PATH" | grep -w disable_he
strings "$WPA_PATH" | grep -w disable_eht
echo "wpasupplicant held at the custom build - 'sudo apt-mark unhold wpasupplicant' to let apt manage it again (and lose this build on the next upgrade)."
