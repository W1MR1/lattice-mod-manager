; Lattice installer additions (included by electron-builder before its own script).

; The first dialog: pick the language of the installer and of Lattice itself.
!define MUI_LANGDLL_WINDOWTITLE "Lattice"
!define MUI_LANGDLL_INFO "Choose the language of Lattice. You can always change it later in Settings."

; The last page repeats in the chosen language that the language can be changed.
!define MUI_FINISHPAGE_TEXT "$(latticeFinishText)"

!macro customHeader
  LangString latticeFinishText ${LANG_ENGLISH} "Lattice has been installed on your computer.$\r$\n$\r$\nLattice will use the language you chose. You can always change it in Lattice: Settings → Appearance → Language.$\r$\n$\r$\nClick Finish to close Setup."
  LangString latticeFinishText ${LANG_SIMPCHINESE} "Lattice 已安装到你的电脑上。$\r$\n$\r$\nLattice 将使用你选择的语言。之后可以随时在 Lattice 中更改：设置 → 外观 → 语言。$\r$\n$\r$\n点击“完成”关闭安装程序。"
  LangString latticeFinishText ${LANG_RUSSIAN} "Lattice установлен на ваш компьютер.$\r$\n$\r$\nLattice будет работать на выбранном языке. Его всегда можно сменить в самом Lattice: Настройки → Вид → Язык.$\r$\n$\r$\nНажмите «Готово», чтобы закрыть установщик."
  LangString latticeFinishText ${LANG_SPANISHINTERNATIONAL} "Lattice se ha instalado en tu equipo.$\r$\n$\r$\nLattice usará el idioma que elegiste. Siempre puedes cambiarlo en Lattice: Ajustes → Apariencia → Idioma.$\r$\n$\r$\nHaz clic en Terminar para cerrar el instalador."
  LangString latticeFinishText ${LANG_PORTUGUESEBR} "O Lattice foi instalado no seu computador.$\r$\n$\r$\nO Lattice usará o idioma que você escolheu. Você pode trocá-lo a qualquer momento no Lattice: Configurações → Aparência → Idioma.$\r$\n$\r$\nClique em Concluir para fechar o instalador."
  LangString latticeRemoveData ${LANG_ENGLISH} "Lattice has taken its mods out of your game folders.$\r$\n$\r$\nAlso delete Lattice's downloaded mods, profiles and settings? Keep them if you plan to install Lattice again."
  LangString latticeRemoveData ${LANG_SIMPCHINESE} "Lattice 已从游戏文件夹中移除它放入的模组。$\r$\n$\r$\n是否同时删除 Lattice 下载的模组、配置文件和设置？如果打算重新安装 Lattice，可以保留。"
  LangString latticeRemoveData ${LANG_RUSSIAN} "Lattice убрал свои моды из папок игр.$\r$\n$\r$\nУдалить также скачанные моды, профили и настройки Lattice? Оставьте их, если собираетесь установить Lattice снова."
  LangString latticeRemoveData ${LANG_SPANISHINTERNATIONAL} "Lattice ha quitado sus mods de las carpetas de los juegos.$\r$\n$\r$\n¿Eliminar también los mods descargados, los perfiles y los ajustes de Lattice? Consérvalos si piensas volver a instalar Lattice."
  LangString latticeRemoveData ${LANG_PORTUGUESEBR} "O Lattice tirou seus mods das pastas dos jogos.$\r$\n$\r$\nExcluir também os mods baixados, perfis e configurações do Lattice? Mantenha-os se pretende instalar o Lattice de novo."
  LangString latticeRemoveData ${LANG_GERMAN} "Lattice hat seine Mods aus den Spielordnern entfernt.$\r$\n$\r$\nAuch die heruntergeladenen Mods, Profile und Einstellungen von Lattice löschen? Behalte sie, wenn du Lattice wieder installieren willst."
  LangString latticeFinishText ${LANG_GERMAN} "Lattice wurde auf deinem Computer installiert.$\r$\n$\r$\nLattice verwendet die gewählte Sprache. Du kannst sie in Lattice jederzeit ändern: Einstellungen → Darstellung → Sprache.$\r$\n$\r$\nKlicke auf „Fertig stellen“, um das Setup zu schließen."
!macroend

; Uninstalling (not updating): Lattice takes its mods out of every game folder and
; gives the games their own files back; then asks whether to delete its downloads and profiles.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\Lattice.exe" --purge-all'
    MessageBox MB_YESNO|MB_ICONQUESTION "$(latticeRemoveData)" /SD IDNO IDNO lattice_keep_data
      RMDir /r "$APPDATA\Lattice"
    lattice_keep_data:
  ${endIf}
!macroend

; Lattice reads the chosen language (a Windows language id) on its first start.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\installer-language" w
  FileWrite $0 "$LANGUAGE"
  FileClose $0
!macroend
