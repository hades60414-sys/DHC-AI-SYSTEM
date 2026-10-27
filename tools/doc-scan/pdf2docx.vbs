Option Explicit
' pdf2docx.vbs <listfile> <outdir>
' Opens each listed PDF in Word (read-only) and saves a .docx copy into outdir.
' Sources are never modified. Existing outputs are skipped, so reruns resume.
Dim fso, listPath, outDir, st, lines, i, total, src, dst, doc, chars, pages, status, logS, word, nOk, nLow, nFail, nSkip
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count < 2 Then
  WScript.Echo "usage: cscript pdf2docx.vbs <listfile> <outdir>"
  WScript.Quit 2
End If
listPath = WScript.Arguments(0)
outDir = WScript.Arguments(1)
If Not fso.FolderExists(outDir) Then fso.CreateFolder outDir

Set st = CreateObject("ADODB.Stream")
st.Type = 2: st.Charset = "utf-8": st.Open
st.LoadFromFile listPath
lines = Split(Replace(st.ReadText(-1), vbCr, ""), vbLf)
st.Close
total = 0
For i = 0 To UBound(lines)
  If Trim(lines(i)) <> "" Then total = total + 1
Next

Set logS = CreateObject("ADODB.Stream")
logS.Type = 2: logS.Charset = "utf-8": logS.Open
logS.WriteText "status" & vbTab & "chars" & vbTab & "pages" & vbTab & "source" & vbLf

' Suppress Word's "will now convert your PDF" prompt (per-user Word option).
CreateObject("WScript.Shell").RegWrite "HKCU\Software\Microsoft\Office\16.0\Word\Options\DisableConvertPdfWarning", 1, "REG_DWORD"
Set word = CreateObject("Word.Application")
word.Visible = False
word.DisplayAlerts = 0

nOk = 0: nLow = 0: nFail = 0: nSkip = 0: total = 0
For i = 0 To UBound(lines)
  src = Trim(lines(i))
  If src <> "" Then
    total = total + 1
    dst = outDir & "\" & fso.GetBaseName(src) & ".docx"
    chars = "": pages = ""
    If fso.FileExists(dst) Then
      status = "SKIP": nSkip = nSkip + 1
    Else
      On Error Resume Next
      Set doc = word.Documents.Open(src, False, True, False)
      If Err.Number <> 0 Then
        status = "FAIL_OPEN": nFail = nFail + 1: Err.Clear
      Else
        chars = doc.Content.Characters.Count
        pages = doc.ComputeStatistics(2)
        doc.SaveAs2 dst, 16
        If Err.Number <> 0 Then
          status = "FAIL_SAVE": nFail = nFail + 1: Err.Clear
        ElseIf pages > 0 And chars / pages < 150 Then
          status = "LOW_TEXT": nLow = nLow + 1
        Else
          status = "OK": nOk = nOk + 1
        End If
        doc.Close False
        Err.Clear
      End If
      On Error GoTo 0
    End If
    WScript.Echo "[" & total & "] " & status & "  chars=" & chars & " pages=" & pages
    logS.WriteText status & vbTab & chars & vbTab & pages & vbTab & src & vbLf
  End If
Next
word.Quit
logS.SaveToFile outDir & "\convert-log.tsv", 2
logS.Close
WScript.Echo "Done. OK=" & nOk & " LOW_TEXT=" & nLow & " FAIL=" & nFail & " SKIP=" & nSkip
WScript.Echo "LOW_TEXT = probably a scanned PDF; its .docx has little or no text."
