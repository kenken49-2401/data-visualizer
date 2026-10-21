; The watcher lives outside $INSTDIR so it does not lock application updates.
; Stop only this user's own staged watcher executables. History and settings
; are intentionally outside the subdirectory removed on a full uninstall.
!macro customUnInstall
  Push $R0
  Push $R1
  Push $R2

  ; An update applied on normal quit may not restart Electron. Keep the
  ; independently staged watcher alive so it can launch the new app later.
  ${ifNot} ${isUpdated}
    ClearErrors
    FindFirst $R0 $R1 "$APPDATA\codex-usage-overlay\autostart\watcher-*.exe"
    IfErrors codex_autostart_not_found
codex_autostart_find_next:
    StrCmp $R1 "" codex_autostart_find_done
    ExecWait '"$APPDATA\codex-usage-overlay\autostart\$R1" --stop' $R2
    ClearErrors
    FindNext $R0 $R1
    IfErrors codex_autostart_find_done
    Goto codex_autostart_find_next
codex_autostart_find_done:
    FindClose $R0
codex_autostart_not_found:

    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CodexUsageOverlayChatGPTLauncher"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CodexUsageOverlayChatGPTLauncher"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32" "CodexUsageOverlayChatGPTLauncher"
    RMDir /r "$APPDATA\codex-usage-overlay\autostart"
  ${endIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend
