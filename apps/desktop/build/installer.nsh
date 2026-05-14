; ─────────────────────────────────────────────────────────────────────────
;  Hook custom de NSIS — Santa Teresita Installer
;
;  electron-builder llama estos macros en momentos específicos del flow de
;  instalación (ver https://www.electron.build/configuration/nsis#custom-nsis-script).
;
;  Lo que hacemos acá:
;    Después de extraer los archivos de Santa Teresita, verificamos si el
;    Microsoft Visual C++ 2015-2022 Redistributable (x64) está instalado.
;    Si NO está, ejecutamos el `vc_redist.x64.exe` que viene bundleado en
;    el installer en modo silencioso (sin diálogos, sin reinicio).
;
;  Histórico: era requerido para embedded-postgres (postgres.exe). Desde
;  alpha.18 la app es cloud-first y NO usa Postgres local, pero conservamos
;  el check porque better-sqlite3 (outbox local) y prebuilt nativos de
;  Node/Electron también dependen de las DLLs vcruntime140 / msvcp140.
;
;  Optimización alpha.18: en instalaciones donde VC++ ya está, antes el
;  installer leía el registro (lento en PCs sin SSD, ~5-10s). Ahora primero
;  chequeamos si vcruntime140.dll está en System32 — fast path que evita
;  el registro. Solo si la DLL falta caemos al chequeo de registro.
; ─────────────────────────────────────────────────────────────────────────

!macro customInstall
  DetailPrint "Extrayendo Santa Teresita... (puede tardar ~60s, no se colgó)"
  DetailPrint "Verificando Microsoft Visual C++ Redistributable..."

  ; Fast path: si las DLLs claves ya están en System32, asumimos VC++ instalado.
  ; Esto evita el ReadRegDword (~5-10s en PCs sin SSD).
  StrCpy $0 "0"
  ${If} ${FileExists} "$SYSDIR\vcruntime140.dll"
  ${AndIf} ${FileExists} "$SYSDIR\msvcp140.dll"
    StrCpy $0 "1"
    DetailPrint "VC++ DLLs presentes en System32, saltando."
  ${Else}
    ; Fallback: chequear registro (versiones 14.0/14.1x/14.2x/14.3x comparten clave)
    ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  ${EndIf}

  ${If} $0 == "1"
    DetailPrint "VC++ Redist ya está instalado, saltando."
  ${Else}
    DetailPrint "VC++ Redist no detectado — instalando..."

    ; Extraer el .exe bundleado a la carpeta temporal del installer
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"

    ; Ejecutar silencioso. Flags:
    ;   /install   — instala (no repara)
    ;   /quiet     — sin UI
    ;   /norestart — NO reinicia la PC al terminar (continuamos con nuestro install)
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1

    ${If} $1 == "0"
      DetailPrint "VC++ Redist instalado OK."
    ${ElseIf} $1 == "1638"
      ; 1638 = "Another version of this product is already installed" — OK también
      DetailPrint "VC++ Redist ya estaba (otra versión), seguimos."
    ${ElseIf} $1 == "3010"
      ; 3010 = "Restart required" — NO reiniciamos ahora; al primer uso post
      ; instalación las DLLs ya quedan resueltas. Si fallara, el usuario reinicia.
      DetailPrint "VC++ Redist instalado, requiere reinicio (lo postponemos)."
    ${Else}
      DetailPrint "VC++ Redist install retornó código $1. Continuamos igual."
      ; No abortamos la instalación de Santa Teresita — si VC++ falló, el
      ; error real saldrá al primer arranque y el log de la app lo capturará.
    ${EndIf}
  ${EndIf}
!macroend
