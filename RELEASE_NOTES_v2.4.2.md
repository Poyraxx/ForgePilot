## What's New in v2.4.2

- The Linux AppImage now uses the static AppImage runtime, so it no longer needs `libfuse2` on the host system.
- The AppImage file name no longer contains `linux` (`ForgePilot-<version>-x86_64.AppImage`), following AppImage naming conventions.
- Added an AppImage smoke test that starts the AppImage the way the AppImage catalog does (Xvfb at 800x600, no network) and checks that the window shows content.

### Downloads

- Windows: x64 portable `.exe`.
- macOS: Apple Silicon `arm64` and Intel `x64` `.dmg` or `.zip`.
- Linux: x64 `.AppImage` and Debian/Ubuntu `.deb`.

Local model servers and hosted provider credentials are configured separately. Document extraction requires the documented Python dependencies. macOS builds are unsigned and not notarized.
