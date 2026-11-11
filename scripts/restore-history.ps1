param(
    [string]$SourceConfig,
    [string]$TargetConfig = (Join-Path $env:LOCALAPPDATA 'SumatraPDF-AI\SumatraPDF-settings.txt'),
    [string]$BackupRoot,
    [switch]$DryRun,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if ($Apply -and $DryRun) { throw 'Choose either -Apply or -DryRun.' }
Import-Module (Join-Path $PSScriptRoot 'history-config.psm1') -Force -DisableNameChecking
function Write-HistoryBackup {
    param([string]$Path, [byte[]]$Bytes)
    $stream = New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
$target = Read-SumatraConfig -Path $TargetConfig
if ($SourceConfig) { $source = Read-SumatraConfig -Path $SourceConfig }
else {
    $selected = Select-SumatraHistorySource
    if (-not $selected) { throw 'No existing SumatraPDF configuration was found.' }
    $source = $selected.Config
}
if ([string]::Equals($source.Path,$target.Path,[StringComparison]::OrdinalIgnoreCase)) { throw 'Source and target configurations must differ.' }
$merge = Merge-SumatraHistory -CurrentText $target.Text -SourceText $source.Text
$summary = [ordered]@{
    Mode = $(if ($Apply) { 'Apply' } else { 'DryRun' });
    Current = $merge.CurrentCount; Source = $merge.SourceCount;
    Merged = $merge.Merged; Added = $merge.Added; Overlap = $merge.Overlap;
    CurrentDuplicates = $merge.CurrentDuplicates; SourceDuplicates = $merge.SourceDuplicates;
    Changed = $merge.Changed
}
if (-not $Apply -or -not $merge.Changed) { [pscustomobject]$summary; return }

$dataDirectory = [IO.Path]::GetDirectoryName($target.Path)
$defaultData = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SumatraPDF-AI')).TrimEnd('\')
$installedExe = Join-Path $env:LOCALAPPDATA 'Programs\SumatraPDF-AI\SumatraPDF.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name='SumatraPDF.exe'" | Where-Object {
    $command = [regex]::Match([string]$_.CommandLine,'(?i)(?:^|\s)-appdata\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))')
    $processData = if ($command.Groups['quoted'].Success) { $command.Groups['quoted'].Value } else { $command.Groups['plain'].Value }
    $sameData = $processData -and [string]::Equals([IO.Path]::GetFullPath($processData).TrimEnd('\'),$dataDirectory,[StringComparison]::OrdinalIgnoreCase)
    $defaultInstance = [string]::Equals($dataDirectory,$defaultData,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($_.ExecutablePath,$installedExe,[StringComparison]::OrdinalIgnoreCase)
    $sameData -or $defaultInstance
})
if ($running.Count) { throw 'Close SumatraPDF AI normally before applying the history restore.' }

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $expected = [Convert]::ToBase64String($sha.ComputeHash($target.Bytes))
    $actual = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($target.Path)))
} finally { $sha.Dispose() }
if ($actual -ne $expected) { throw 'AI settings changed during the restore preview; run it again after closing the app.' }
if (-not $BackupRoot) { $BackupRoot = Join-Path $dataDirectory 'backups' }
$backupDirectory = Join-Path ([IO.Path]::GetFullPath($BackupRoot)) ('restore-history-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
Write-HistoryBackup -Path (Join-Path $backupDirectory 'AI-settings-before.txt') -Bytes $target.Bytes
Write-HistoryBackup -Path (Join-Path $backupDirectory 'Source-settings-original.txt') -Bytes $source.Bytes
$notesPath = Join-Path $dataDirectory 'context-notes.dat'
$summary.ContextNotesBackedUp = [IO.File]::Exists($notesPath)
if ($summary.ContextNotesBackedUp) {
    $inputStream = [IO.File]::OpenRead($notesPath)
    try {
        $outputStream = New-Object IO.FileStream((Join-Path $backupDirectory 'context-notes.dat'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
        try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
}
[IO.File]::WriteAllText((Join-Path $backupDirectory 'summary.json'),($summary | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))

[byte[]]$body = $target.Encoding.GetBytes($merge.Text)
[byte[]]$bytes = $target.Preamble + $body
$temporary = $target.Path + '.restore-' + [Guid]::NewGuid().ToString('N') + '.tmp'
try {
    $stream = New-Object IO.FileStream($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $latest = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($target.Path))) } finally { $sha.Dispose() }
    if ($latest -ne $expected) { throw 'AI settings changed before replacement; original settings were kept.' }
    [IO.File]::Replace($temporary,$target.Path,[NullString]::Value,$true)
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
$summary.BackupDirectory = $backupDirectory
[pscustomobject]$summary
