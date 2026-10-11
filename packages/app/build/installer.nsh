; Included in the Windows installer and uninstaller (stage.mjs, nsis.include). Before they close a running
; Kilnframe, they check whether an animation is being made: the app keeps %USERPROFILE%\.kilnframe\job-running
; while a job runs (src/quit.ts). Closing it then would stop the job and lose the tokens it used, so the
; installer asks to try again once the job is done. A silent install (the app's own update) never asks: the app
; offers its update only when no job runs. Then electron-builder's usual check closes Kilnframe.

; what electron-builder includes itself when no customCheckAppRunning is defined
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  ; first: it declares the variable FIND_PROCESS reads
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${IfNot} ${Silent}
    kilnframeJobCheck:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
    ${AndIf} ${FileExists} "$PROFILE\.kilnframe\job-running"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Kilnframe şu an bir animasyon hazırlıyor. Kurulum onu durdurur ve harcanan token boşa gider. Animasyon bitince Yeniden Dene'ye basın.$\r$\n$\r$\nKilnframe is making an animation. Installing now would stop it and lose the tokens it used. Press Retry once the animation is done." IDRETRY kilnframeJobCheck
      Quit
    ${EndIf}
  ${EndIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend
