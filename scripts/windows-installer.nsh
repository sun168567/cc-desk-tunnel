; The ccdt the client carries (resources\ccdt) goes on the current user's PATH when the client is installed, and off
; it when the client is removed; an update keeps it there. apps/cli/install/desktop-path.ps1 edits the PATH.

!macro ccdtPath Switch
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\ccdt\desktop-path.ps1" -Directory "$INSTDIR\resources\ccdt" ${Switch}'
  Pop $0
!macroend

!macro customInstall
  !insertmacro ccdtPath ""
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro ccdtPath "-Remove"
  ${endIf}
!macroend
