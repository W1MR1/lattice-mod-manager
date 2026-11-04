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
  LangString latticeFinishText ${LANG_GERMAN} "Lattice wurde auf deinem Computer installiert.$\r$\n$\r$\nLattice verwendet die gewählte Sprache. Du kannst sie in Lattice jederzeit ändern: Einstellungen → Darstellung → Sprache.$\r$\n$\r$\nKlicke auf „Fertig stellen“, um das Setup zu schließen."
!macroend

; Lattice reads the chosen language (a Windows language id) on its first start.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\installer-language" w
  FileWrite $0 "$LANGUAGE"
  FileClose $0
!macroend
