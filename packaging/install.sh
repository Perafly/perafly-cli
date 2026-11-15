#!/bin/sh
# Perafly CLI kurulum betiği (README §8). macOS ve Linux; POSIX sh.
#
#   curl -fsSL https://github.com/perafly/perafly-cli/releases/latest/download/install.sh | sh
#
# Platformu algılar, tek dosya ikiliyi ve SHA256SUMS'u indirir, SHA-256 özetini doğrular (uymazsa hiçbir şey kurmaz),
# ~/.perafly/bin'e kurar ve PATH talimatı verir. sudo istemez, kabuk dosyalarını değiştirmez. Yalnız iki dosya indirir:
# belirteç, kimlik bilgisi ya da kişisel veri göndermez.
#
# Ortam değişkenleri:
#   PERAFLY_VERSION        kurulacak sürüm (ör. 0.8.0 ya da v0.8.0); verilmezse en son yayımlanan
#   PERAFLY_INSTALL_DIR    kurulum klasörü (varsayılan ~/.perafly/bin)
#   PERAFLY_DOWNLOAD_BASE  ikililerin ve SHA256SUMS'un durduğu adres (ayna ya da yerel deneme); dosyalar bu adresin
#                          altından olduğu gibi alınır. https; http yalnız localhost için
#   PERAFLY_REPOSITORY     GitHub deposu (sahip/ad); varsayılan aşağıda

set -eu

# packaging/release.json "repository" ile aynı olmalı (test/release.test.ts denetler)
DEFAULT_REPOSITORY="perafly/perafly-cli"

tmp=""
staged=""

say() { printf '%s\n' "$*"; }
fail() {
    printf 'perafly install: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [ -n "$staged" ]; then rm -f "$staged"; fi
    if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

is_musl() {
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then return 0; fi
    for f in /lib/ld-musl-*; do
        if [ -e "$f" ]; then return 0; fi
    done
    return 1
}

# İşletim sistemi ve işlemci → perafly-<os>-<arch> (scripts/lib/release.mjs TARGETS)
detect_target() {
    os=$(uname -s)
    case "$os" in
        Darwin) os=darwin ;;
        Linux) os=linux ;;
        *) fail "unsupported operating system: $os. On Windows use install.ps1; elsewhere run npm install -g perafly (Node 22+)." ;;
    esac
    cpu=$(uname -m)
    case "$cpu" in
        x86_64 | amd64) cpu=x64 ;;
        arm64 | aarch64) cpu=arm64 ;;
        *) fail "unsupported CPU: $cpu. Run npm install -g perafly (Node 22+)." ;;
    esac
    # Apple Silicon'da Rosetta altında çalışan kabuk: yerel ikili kurulur
    if [ "$os" = darwin ] && [ "$cpu" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        cpu=arm64
    fi
    # İkili resmî Node derlemesini taşır ve glibc ister
    if [ "$os" = linux ] && is_musl; then
        fail "musl libc (e.g. Alpine) is not supported by the binary. Run npm install -g perafly (Node 22+)."
    fi
    target="$os-$cpu"
}

download() {
    # $1 adres, $2 hedef dosya
    if command -v curl >/dev/null 2>&1; then
        if [ "$secure" = 1 ]; then
            curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 -o "$2" "$1"
        else
            curl -fsSL -o "$2" "$1"
        fi
    elif command -v wget >/dev/null 2>&1; then
        if [ "$secure" = 1 ] && wget --help 2>&1 | grep -q -- '--https-only'; then
            wget -q --https-only -O "$2" "$1"
        else
            wget -q -O "$2" "$1"
        fi
    else
        fail "curl or wget is required"
    fi
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print tolower($1) }'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{ print tolower($1) }'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{ print tolower($NF) }'
    else
        return 1
    fi
}

path_hint() {
    case "$(basename "${SHELL:-sh}")" in
        zsh) rc="$HOME/.zshrc" line="export PATH=\"$install_dir:\$PATH\"" ;;
        bash)
            if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
            line="export PATH=\"$install_dir:\$PATH\""
            ;;
        fish) rc="$HOME/.config/fish/config.fish" line="fish_add_path \"$install_dir\"" ;;
        *) rc="$HOME/.profile" line="export PATH=\"$install_dir:\$PATH\"" ;;
    esac
    say ""
    say "$install_dir is not on your PATH. Add it by appending this line to $rc:"
    say ""
    say "  $line"
    say ""
    say "Then open a new terminal and run: perafly --help"
}

main() {
    detect_target
    asset="perafly-$target"

    version="${PERAFLY_VERSION:-latest}"
    version="${version#v}"
    if [ "$version" != latest ] && ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
        fail "PERAFLY_VERSION must look like 1.2.3"
    fi

    repository="${PERAFLY_REPOSITORY:-$DEFAULT_REPOSITORY}"
    if ! printf '%s' "$repository" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$'; then
        fail "PERAFLY_REPOSITORY must be owner/name"
    fi
    if [ -n "${PERAFLY_DOWNLOAD_BASE:-}" ]; then
        base="${PERAFLY_DOWNLOAD_BASE%/}"
    elif [ "$version" = latest ]; then
        base="https://github.com/$repository/releases/latest/download"
    else
        base="https://github.com/$repository/releases/download/v$version"
    fi
    case "$base" in
        https://*) secure=1 ;;
        http://127.0.0.1:* | http://127.0.0.1/* | http://localhost:* | http://localhost/* | http://\[::1\]:*) secure=0 ;;
        *) fail "PERAFLY_DOWNLOAD_BASE must use https (plain http is allowed only for localhost)" ;;
    esac

    install_dir="${PERAFLY_INSTALL_DIR:-$HOME/.perafly/bin}"
    case "$install_dir" in
        /*) ;;
        *) fail "PERAFLY_INSTALL_DIR must be an absolute path" ;;
    esac

    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    tmp=$(mktemp -d 2>/dev/null || mktemp -d -t perafly) || fail "could not create a temporary folder"

    say "Downloading $asset ($version) from $base"
    download "$base/$asset" "$tmp/$asset" || fail "could not download $base/$asset"
    download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

    # Özet doğrulaması: SHA256SUMS'ta bu dosya için tam bir satır olmalı ve özet tutmalı; yoksa hiçbir şey kurulmaz
    expected=$(awk -v name="$asset" '($2 == name || $2 == "*" name) { print tolower($1) }' "$tmp/SHA256SUMS")
    if [ -z "$expected" ] || [ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" != 1 ]; then
        fail "SHA256SUMS has no single entry for $asset. Nothing was installed."
    fi
    if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
        fail "SHA256SUMS entry for $asset is malformed. Nothing was installed."
    fi
    actual=$(sha256_of "$tmp/$asset") || fail "no SHA-256 tool found (sha256sum, shasum or openssl)"
    if [ "$actual" != "$expected" ]; then
        fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."
    fi
    say "Checksum verified (sha256 $actual)"

    mkdir -p "$install_dir" 2>/dev/null || fail "cannot create $install_dir. Set PERAFLY_INSTALL_DIR to a folder you can write to (this script never uses sudo)."
    if [ ! -w "$install_dir" ]; then
        fail "$install_dir is not writable. Set PERAFLY_INSTALL_DIR to a folder you can write to (this script never uses sudo)."
    fi
    # Kurulum klasöründe sınanır (geçici klasör noexec bağlanmış olabilir), sonra aynı dosya sisteminde yerine taşınır
    staged="$install_dir/.perafly-install.$$"
    cp "$tmp/$asset" "$staged" || fail "could not write to $install_dir"
    chmod 755 "$staged"
    got=$("$staged" --version 2>/dev/null) || fail "the downloaded binary does not run on this machine. Nothing was installed."
    if [ "$version" != latest ] && [ "$got" != "$version" ]; then
        fail "the downloaded binary is version $got, expected $version. Nothing was installed."
    fi
    mv -f "$staged" "$install_dir/perafly"
    staged=""

    # Kısa ad (npm paketindeki gibi): yalnız yoksa ya da zaten bizimse
    if [ ! -e "$install_dir/pf" ] && [ ! -L "$install_dir/pf" ]; then
        ln -s perafly "$install_dir/pf"
    elif [ ! -L "$install_dir/pf" ] || [ "$(readlink "$install_dir/pf")" != perafly ]; then
        say "Note: $install_dir/pf already exists; the pf alias was not created."
    fi

    say "Installed perafly $got to $install_dir/perafly"
    case ":${PATH:-}:" in
        *":$install_dir:"*) say "Run: perafly --help" ;;
        *) path_hint ;;
    esac
}

main "$@"
