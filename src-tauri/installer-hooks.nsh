; LunoPeak NSIS installer hooks.
;
; v1.1.0 shipped with installMode "both", which let users pick between a
; per-user (HKCU) and per-machine (HKLM) install. v1.2.0+ locks the mode
; to currentUser in tauri.conf.json, so future upgrades stay in HKCU and
; Tauri's normal upgrade detection replaces the prior version cleanly.
;
; The wrinkle: anyone who picked perMachine on a 1.1.0 install now has a
; leftover HKLM entry that this currentUser installer can't see, so the
; two installs coexist as separate Start menu / taskbar entries pointing
; at different binaries.
;
; This preinstall hook reads HKLM directly, finds the orphan, and offers
; to uninstall it silently before the new install proceeds.

!macro NSIS_HOOK_PREINSTALL
  ; During in-app updates the updater plugin launches this installer via
  ; ShellExecuteW and only *then* exits the running app, so we always start
  ; while the old lunopeak.exe is still alive. Tauri's CheckIfAppIsRunning
  ; (which runs right after this hook) is a one-shot snapshot with a fixed
  ; 500ms grace, and TerminateProcess/ExitProcess are asynchronous — if the
  ; exe's file lock outlives that, extraction hits NSIS's Abort/Retry/Ignore
  ; "error opening file for writing" dialog. Poll until the old instance is
  ; actually gone (max ~10s) so the check never races the teardown. On
  ; timeout we fall through and let CheckIfAppIsRunning kill it as before.
  ; Manual (non-update) installs skip this and keep the close-app prompt.
  ${If} $UpdateMode = 1
    StrCpy $R9 0
    lunopeak_wait_exit:
      nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
      Pop $R8
      ${If} $R8 != 0 ; non-zero = no process found, old instance is gone
        Goto lunopeak_wait_done
      ${EndIf}
      IntOp $R9 $R9 + 1
      ${If} $R9 > 50 ; ~10s
        Goto lunopeak_wait_done
      ${EndIf}
      Sleep 200
      Goto lunopeak_wait_exit
    lunopeak_wait_done:
      ; Grace period for Windows to release the exe's file lock (and for
      ; AV scan-on-exit handles to close) after the process object dies.
      Sleep 300
  ${EndIf}

  ; Tauri 2 writes per-machine uninstall metadata under
  ; HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}.
  ; UninstallString is the full quoted path to the prior uninstaller.
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  ${If} $R0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "An older system-wide installation of ${PRODUCTNAME} was detected.$\n$\nRemoving it now will leave you with a single up-to-date copy. Start menu and taskbar shortcuts will be refreshed.$\n$\nRemove the old installation?" /SD IDYES IDNO lunopeak_skip_old_uninstall
      ; UninstallString already contains quotes around the exe path. /S
      ; runs the prior uninstaller silently so the user only sees this
      ; installer's progress UI.
      ExecWait '$R0 /S'
    lunopeak_skip_old_uninstall:
  ${EndIf}
!macroend
