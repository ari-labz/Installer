# A·R·I Installer

One app that installs and updates the A·R·I Server and A·R·I Desktop.

Releases of the apps themselves live in their own repos:
- Server: https://github.com/ari-labz/A.R.I
- Desktop: https://github.com/ari-labz/A.R.I-Desktop

## Development

```bash
./dev.sh
```

## Releasing

Edit `.github/release-notes/installer.md`, then push a tag `ARI_Installer_v<version>`. GitHub Actions builds the
macOS, Windows and Linux installers and publishes them as the latest release.
