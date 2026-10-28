' dsh-guard silent launcher for guard-autostart.ps1
'
' WHY THIS FILE EXISTS: Task Scheduler starts a console program with a visible
' console window, so a task whose action is powershell.exe flashes a black window
' on every tick. wscript.exe is a GUI-subsystem program and shows nothing, and the
' shell.Run(..., 0, ...) below starts PowerShell with SW_HIDE, so the whole chain
' runs invisibly.
'
' The installer fills in @@SCRIPT@@ and @@DSH_HOME@@ and writes this file under
' <DshHome>\guard\. A DSH_HOME argument on the command line overrides the baked
' one, which is only used for testing.
Option Explicit

Dim scriptPath, dshHome, shell, command

scriptPath = "@@SCRIPT@@"
dshHome = "@@DSH_HOME@@"

If WScript.Arguments.Count > 0 Then dshHome = WScript.Arguments(0)

Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden" & _
	" -ExecutionPolicy Bypass -File """ & scriptPath & """" & _
	" -DshHome """ & dshHome & """"

' 0 = hidden window, False = do not wait for it.
shell.Run command, 0, False
