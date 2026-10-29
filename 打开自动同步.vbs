Option Explicit
Dim shell, files, root, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
result = shell.Run("node " & Chr(34) & root & "\service\launch.mjs" & Chr(34), 0, True)
If result <> 0 Then
  MsgBox "Could not start. Open the CMD launcher in this folder to view details.", 48, "Anchor Auto Sync"
End If
