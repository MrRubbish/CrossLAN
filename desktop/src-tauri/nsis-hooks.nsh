!macro NSIS_HOOK_PREINSTALL
  ; Stop an older CrossLAN instance before replacing its sidecar binary.
  ; taskkill is intentionally scoped to CrossLAN process names only.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-desktop.exe'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-server.exe'
  Sleep 750
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The uninstaller can be started while CrossLAN is still running.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-desktop.exe'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-server.exe'
  Sleep 750
!macroend
