' Lanza el vigilante sin ventana de consola.
' Se usa desde la tarea programada (instalar-inicio-automatico.ps1).
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = carpeta
shell.Run "node """ & carpeta & "\watcher.js""", 0, False
