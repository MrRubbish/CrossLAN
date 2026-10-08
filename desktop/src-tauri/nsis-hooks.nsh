!macro NSIS_HOOK_PREINSTALL
  ; Stop an older CrossLAN instance before replacing its sidecar binary.
  ; taskkill is intentionally scoped to CrossLAN process names only.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-desktop.exe'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-server.exe'
  Sleep 750
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The per-user installer is not elevated. Ask once here so every Windows
  ; network profile can reach the sidecar, while limiting access to the local
  ; subnet and to this exact executable. Program-scoped rules keep working
  ; when the user changes CrossLAN's configurable HTTP port.
  Push $9
  FileOpen $9 "$TEMP\crosslan-firewall-install.txt" w
  FileWrite $9 'advfirewall firewall delete rule name="CrossLAN LAN transfer (TCP)"$\r$\n'
  FileWrite $9 'advfirewall firewall delete rule name="CrossLAN device discovery (UDP)"$\r$\n'
  FileWrite $9 'advfirewall firewall add rule name="CrossLAN LAN transfer (TCP)" dir=in action=allow program="$INSTDIR\crosslan-server.exe" enable=yes profile=any remoteip=localsubnet protocol=TCP edge=no$\r$\n'
  FileWrite $9 'advfirewall firewall add rule name="CrossLAN device discovery (UDP)" dir=in action=allow program="$INSTDIR\crosslan-server.exe" enable=yes profile=any remoteip=localsubnet protocol=UDP edge=no$\r$\n'
  FileClose $9
  ClearErrors
  ExecShellWait "runas" "$SYSDIR\netsh.exe" '-f "$TEMP\crosslan-firewall-install.txt"' SW_HIDE

  ; Verify the actual installed rules instead of trusting the ShellExecute exit
  ; status. `netsh` can return a failure status for deleting a rule that did not
  ; exist even though both replacement rules were created successfully.
  FileOpen $9 "$TEMP\crosslan-firewall-verify.ps1" w
  FileWrite $9 '$$exe = "$INSTDIR\crosslan-server.exe"$\r$\n'
  FileWrite $9 '$$names = @("CrossLAN LAN transfer (TCP)", "CrossLAN device discovery (UDP)")$\r$\n'
  FileWrite $9 'foreach ($$name in $$names) {$\r$\n'
  FileWrite $9 '  $$rule = & netsh.exe advfirewall firewall show rule name="$$name" verbose | Out-String$\r$\n'
  FileWrite $9 '  if ($$LASTEXITCODE -ne 0 -or -not $$rule.Contains($$exe)) { exit 1 }$\r$\n'
  FileWrite $9 '}$\r$\n'
  FileWrite $9 'exit 0$\r$\n'
  FileClose $9

  ClearErrors
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\crosslan-firewall-verify.ps1"' $0
  IfErrors crosslan_firewall_setup_failed
  StrCmp $0 "0" crosslan_firewall_setup_done
crosslan_firewall_setup_failed:
  MessageBox MB_ICONEXCLAMATION|MB_OK "CrossLAN could not configure its LAN firewall rules. Approve the Windows permission prompt or add an inbound rule for crosslan-server.exe before connecting other devices."
crosslan_firewall_setup_done:
  Delete "$TEMP\crosslan-firewall-install.txt"
  Delete "$TEMP\crosslan-firewall-verify.ps1"
  Pop $9
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; The uninstaller can be started while CrossLAN is still running.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-desktop.exe'
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM crosslan-server.exe'
  Sleep 750
  ; Do not remove firewall rules here. NSIS also runs the old uninstaller
  ; during upgrades; deleting them here creates an outage if the elevated
  ; post-install rule refresh is declined or fails. The post-install hook
  ; replaces both rules for the newly installed executable path.
!macroend
