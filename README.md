# Canary Desktop

Linux desktop shell for [Canary CMS](https://github.com/canarylegal/canarycms) — an Electron wrapper that opens your firm’s Canary server in a native window (tray, autostart, deep links, downloads).

**Website:** [canarylegalsoftware.co.uk](https://canarylegalsoftware.co.uk)  
**Server project:** [canarylegal/canarycms](https://github.com/canarylegal/canarycms)

## Download

Install the latest package from **[Releases](https://github.com/canarylegal/canary-desktop/releases)**.

### Debian / Ubuntu (`.deb`)

```bash
sha256sum -c SHA256SUMS
sudo apt install ./canary-desktop_0.1.5_amd64.deb
```

Installs under `/opt/Canary`. Launch **Canary** from the app menu (or `/opt/Canary/canary`).

### Fedora (`.rpm`)

Classic Workstation:

```bash
sha256sum -c SHA256SUMS
sudo dnf install ./canary-desktop-0.1.5-1.x86_64.rpm
```

Immutable Fedora (Silverblue / Kinoite / Atomic) — layer the RPM, then reboot:

```bash
sha256sum -c SHA256SUMS
sudo rpm-ostree install ./canary-desktop-0.1.5-1.x86_64.rpm
sudo systemctl reboot
```

The Fedora package installs under `/usr/lib64/canary` with `/usr/bin/canary` on `PATH` (works with rpm-ostree layering; `/opt` is a poor fit on Atomic).

After install, launch **Canary**, then enter your Canary server URL (for example `https://canary.yourfirm.co.uk`).

## Requirements

- Linux **amd64 / x86_64**
- A reachable Canary CMS deployment (this app is not a standalone server)

## Build from source

`build-packages.sh` packs application source into an existing Electron payload (taken from a prior `canary-desktop_*.deb`), then builds packages with [nfpm](https://nfpm.goreleaser.com/):

```bash
# Place nfpm at .tools/nfpm, or install it on PATH
# Set BASE_DEB if the base package is not already under ./dist
BASE_DEB=./dist/canary-desktop_0.1.5_amd64.deb ./build-packages.sh      # deb + rpm
./build-packages.sh deb   # .deb only
./build-packages.sh rpm   # .rpm only
```

`build-deb.sh` is a thin wrapper around `./build-packages.sh deb`.

Built packages land in `./dist/` (gitignored); publish them via GitHub Releases with `SHA256SUMS`.

## Licence

UNLICENSED / proprietary companion to Canary CMS. Contact [colin@canarylegalsoftware.co.uk](mailto:colin@canarylegalsoftware.co.uk) for redistribution questions. Server source licensing is described in [canarycms LICENSE.txt](https://github.com/canarylegal/canarycms/blob/main/LICENSE.txt).
