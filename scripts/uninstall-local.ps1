$ErrorActionPreference = 'Stop'
$installPath = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$programsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\')
if (-not $installPath.StartsWith($programsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected installation location; no files removed.'
}
$target = Get-Item -LiteralPath $installPath
if ($target.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The installation directory is redirected; no files removed.'
}
$markerPath = Join-Path $installPath 'install-info.json'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Installation marker is missing; no files removed.' }
$info = Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath | ConvertFrom-Json
if ($info.AppId -ne 'SumatraPDF.AI.Local' -or -not [string]::Equals($info.InstallPath, $installPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installation marker does not match this directory; no files removed.'
}
$exePath = Join-Path $installPath 'SumatraPDF.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name='SumatraPDF.exe'" | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $exePath, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count) { throw 'Close SumatraPDF AI before uninstalling.' }
if (@(Get-ChildItem -LiteralPath $installPath -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
    throw 'The installation contains redirected files or directories; no files removed.'
}

$shell = New-Object -ComObject WScript.Shell
$links = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SumatraPDF AI.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'SumatraPDF AI.lnk')
)
foreach ($link in $links) {
    if (-not (Test-Path -LiteralPath $link)) { continue }
    $shortcut = $shell.CreateShortcut($link)
    if ([string]::Equals($shortcut.TargetPath, $exePath, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $link -Force
    }
}
$progId = 'SumatraPDF.AI.PDF'
$progIdKey = "HKCU:\Software\Classes\$progId"
$commandKey = "$progIdKey\shell\open\command"
$openCommand = '"' + $exePath + '" -appdata "' + $info.DataPath + '" "%1"'
if ((Test-Path -LiteralPath $commandKey) -and [string]::Equals((Get-Item -LiteralPath $commandKey).GetValue(''), $openCommand, [StringComparison]::OrdinalIgnoreCase)) {
    $openWith = 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
    if ((Test-Path -LiteralPath $openWith) -and ((Get-Item -LiteralPath $openWith).GetValueNames() -contains $progId)) {
        Remove-ItemProperty -LiteralPath $openWith -Name $progId
    }
    $capabilitiesPath = 'Software\SumatraPDF-AI\Capabilities'
    $capabilitiesKey = 'HKCU:\' + $capabilitiesPath
    $registeredApps = 'HKCU:\Software\RegisteredApplications'
    if ((Test-Path -LiteralPath $registeredApps) -and (Get-Item -LiteralPath $registeredApps).GetValue('SumatraPDF AI') -eq $capabilitiesPath) {
        Remove-ItemProperty -LiteralPath $registeredApps -Name 'SumatraPDF AI'
    }
    if (Test-Path -LiteralPath $capabilitiesKey) { Remove-Item -LiteralPath $capabilitiesKey -Recurse }
    Remove-Item -LiteralPath $progIdKey -Recurse
    if (-not ('SumatraAiAssociations' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SumatraAiAssociations {
    [DllImport("shell32.dll")]
    public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
    }
    [SumatraAiAssociations]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SumatraPDF-AI'
if (Test-Path -LiteralPath $registration) {
    $registeredPath = (Get-ItemProperty -LiteralPath $registration).InstallLocation
    if ([string]::Equals($registeredPath, $installPath, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $registration -Recurse
    }
}
if ((Resolve-Path -LiteralPath $installPath).Path -ne $installPath) { throw 'Installation location changed; no program files removed.' }
Remove-Item -LiteralPath $installPath -Recurse -Force
Write-Output 'SumatraPDF AI removed. Notes and settings were kept in LocalAppData\SumatraPDF-AI.'
