# Canary Desktop

Linux desktop shell for [Canary CMS](https://github.com/canarylegal/canarycms) — an Electron wrapper that opens your firm’s Canary server in a native window (tray, autostart, deep links, downloads).

**Website:** [canarylegalsoftware.co.uk](https://canarylegalsoftware.co.uk)  
**Server project:** [canarylegal/canarycms](https://github.com/canarylegal/canarycms)

## Download (Linux amd64)

Install the latest `.deb` from **[Releases](https://github.com/canarylegal/canary-desktop/releases)**.

```bash
# Example for v0.1.5 — prefer the assets on the latest Release page
sudo apt install ./canary-desktop_0.1.5_amd64.deb
```

Verify the package against `SHA256SUMS` on the same Release before installing.

After install, launch **Canary** from the app menu (or `canary`), then enter your Canary server URL (for example `https://canary.yourfirm.co.uk`).

## Requirements

- Debian/Ubuntu-compatible amd64 Linux
- A reachable Canary CMS deployment (this app is not a standalone server)

## Build from source

This tree packs application source into an existing Electron `.deb` base (see `build-deb.sh`). You need Node.js/`npx` and a prior `canary-desktop_*.deb` that already contains Electron binaries.

```bash
./build-deb.sh
```

Built `.deb` files are gitignored; publish them only via GitHub Releases.

## Licence

UNLICENSED / proprietary companion to Canary CMS. Contact [colin@canarylegalsoftware.co.uk](mailto:colin@canarylegalsoftware.co.uk) for redistribution questions. Server source licensing is described in [canarycms LICENSE.txt](https://github.com/canarylegal/canarycms/blob/main/LICENSE.txt).
