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
;    El embedded-postgres que usamos requiere vcruntime140.dll y msvcp140.dll
;    de ese redistributable para que postgres.exe / initdb.exe arranquen.
;    Sin esto, la app crashea al primer arranque con error 0xC0000135
;    (STATUS_DLL_NOT_FOUND) o 0xC0000005 (access violation).
; ─────────────────────────────────────────────────────────────────────────

!macro customInstall
  DetailPrint "Verificando Microsoft Visual C++ Redistributable..."

  ; Detección robusta: buscamos la clave de registro que escribe el installer
  ; oficial de Microsoft cuando se instala VC++ 2015-2022 x64. Cubre las
  ; versiones 14.0 (VS2015), 14.1x (VS2017), 14.2x (VS2019), 14.3x (VS2022).
  ; Todas comparten el mismo runtime y se sobreescriben (no coexisten).
  ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"

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
