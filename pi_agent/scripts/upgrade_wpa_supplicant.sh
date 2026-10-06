#!/usr/bin/env bash
set -euo pipefail

BUILD_DIR="${WPA_BUILD_DIR:-$HOME/wpa_supplicant-build}"
HOSTAP_REPO="https://w1.fi/hostap.git"

REQUIRED_CONFIG_FLAGS=(
    CONFIG_DRIVER_NL80211=y
    CONFIG_CTRL_IFACE=y
    CONFIG_BACKEND=file
    CONFIG_HT_OVERRIDES=y
    CONFIG_VHT_OVERRIDES=y
    CONFIG_IEEE80211AX=y
    CONFIG_HE_OVERRIDES=y
    CONFIG_IEEE80211BE=y
    # Security modes connect_wifi uses (security=...):
    CONFIG_SAE=y          # WPA3-Personal
    CONFIG_SAE_PK=y       # sae_pk
    CONFIG_OWE=y          # owe (Enhanced Open)
    CONFIG_SUITEB=y       # enterprise (WPA-EAP-SHA256)
    CONFIG_SUITEB192=y    # enterprise_192 (WPA3-Enterprise 192-bit)
    CONFIG_EAP_PEAP=y
    CONFIG_EAP_TTLS=y
    CONFIG_EAP_TLS=y
    CONFIG_EAP_PWD=y
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

build_and_verify() {
    echo "==> Building (this takes a few minutes on a Pi)"
    make clean
    make -j"$(nproc)"

    echo "==> Verifying the build actually has the fields we need"
    for field in disable_ht disable_vht disable_he disable_eht sae_pk rsn_overriding; do
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
