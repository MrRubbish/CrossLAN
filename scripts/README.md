# CrossLAN Scripts

The helper scripts are grouped by platform:

- `windows/`: PowerShell scripts and double-clickable CMD launchers for local Node and Windows logon autostart.
- `unix/`: Bash scripts for Linux and macOS local Node and per-user autostart.
- `common/`: Cross-platform cleanup helpers for generated build files.

Run scripts from the repository root so examples and relative paths stay predictable.

## Windows

```powershell
.\scripts\windows\start-local-background.ps1 -Build -Port 6100
.\scripts\windows\stop-local.ps1
.\scripts\windows\restart-local.ps1 -Port 6100
```

Install or remove logon autostart:

```powershell
.\scripts\windows\install-autostart.ps1 -Build -StartNow -Port 6100
.\scripts\windows\uninstall-autostart.ps1
```

The `.cmd` launchers in `windows/` provide the same common actions by double-click.

## Linux And macOS

```bash
chmod +x scripts/unix/*.sh scripts/common/*.sh
./scripts/unix/start-local.sh --build --background --port 6100
./scripts/unix/stop-local.sh
./scripts/unix/restart-local.sh --port 6100
```

Install or remove per-user autostart:

```bash
./scripts/unix/install-autostart.sh --build --port 6100
./scripts/unix/uninstall-autostart.sh
```

## Cleanup

```powershell
.\scripts\common\clean-generated.ps1
```

```bash
./scripts/common/clean-generated.sh
```
