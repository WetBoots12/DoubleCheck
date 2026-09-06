# Open a generated .docx the way Word does, and say what is inside it.
#
# The unit tests in src/shared/docx.test.mjs read the archive back with a reader
# written for the purpose, which proves the bytes are self-consistent but cannot
# prove that Microsoft's own code accepts them. This does that: System.IO.Packaging
# is the Open Packaging Conventions layer a .docx is opened through, and it enforces
# the relationships and content types that a hand-written package gets wrong.
#
# Development only. Not part of the packaged extension.
#
# Usage, from the repository root:
#   node -e "..." > out.docx     # or use the extension's export button
#   powershell -File tools\docx-check.ps1 out.docx

param([Parameter(Mandatory = $true)][string]$Path)

if (-not (Test-Path $Path)) { Write-Error "No such file: $Path"; exit 1 }
$full = (Resolve-Path $Path).Path

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName WindowsBase

Write-Output "--- as a ZIP archive ---"
$zip = [System.IO.Compression.ZipFile]::OpenRead($full)
foreach ($e in $zip.Entries) { "  {0,-32} {1,6} bytes" -f $e.FullName, $e.Length }
$zip.Dispose()

Write-Output "--- as an Open Packaging Conventions package ---"
$pkg = [System.IO.Packaging.Package]::Open($full, 'Open', 'Read')
foreach ($p in $pkg.GetParts()) { "  {0,-32} {1}" -f $p.Uri, $p.ContentType }

$doc = $pkg.GetParts() | Where-Object { $_.Uri -like '*document.xml' } | Select-Object -First 1
if (-not $doc) { Write-Error "No main document part"; $pkg.Close(); exit 1 }

$reader = New-Object System.IO.StreamReader($doc.GetStream())
$text = $reader.ReadToEnd()
$reader.Close()
$pkg.Close()

$xml = New-Object System.Xml.XmlDocument
$xml.LoadXml($text)
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')

Write-Output "--- what a reader would see ---"
"  paragraphs:  " + $xml.SelectNodes('//w:p', $ns).Count
"  italic runs: " + $xml.SelectNodes('//w:i', $ns).Count
foreach ($p in $xml.SelectNodes('//w:p', $ns)) {
  "  | " + (($p.SelectNodes('.//w:t', $ns) | ForEach-Object { $_.InnerText }) -join '')
}
