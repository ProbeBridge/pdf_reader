param(
    [string]$InstallPath = (Join-Path $env:LOCALAPPDATA 'Programs\SumatraPDF-AI'),
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'sumatrapdf\out\rel64'
$assets = Join-Path $projectRoot 'sumatrapdf\src\notes'
$dataPath = Join-Path $env:LOCALAPPDATA 'SumatraPDF-AI'
Import-Module (Join-Path $PSScriptRoot 'history-config.psm1') -Force -DisableNameChecking
$programsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\')
$InstallPath = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
if (-not $InstallPath.StartsWith($programsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallPath must be a subdirectory of the current user LocalAppData\Programs directory.'
}

$exePath = Join-Path $InstallPath 'SumatraPDF.exe'
$markerPath = Join-Path $InstallPath 'install-info.json'
$binaries = @('SumatraPDF.exe', 'libsumatrapdf.dll', 'PdfFilter.dll', 'PdfPreview.dll', 'sumatrapdf-tool.exe')
$requiredAssets = @(
    'theme.css', 'theme.js',
    'library.css', 'library.js', 'library-model.js',
    'reading-stats.css', 'reading-stats.js', 'reading-stats-model.js',
    'index.html', 'notes.css', 'notes.js', 'bridge.js', 'icons.js', 'network.js', 'note-store.js',
    'history.html', 'history.css', 'history.js', 'history-model.js',
    'reflow.html', 'reflow.css', 'reflow.js', 'reflow-model.js',
    'shared\i18n.js', 'shared\llm.js', 'shared\markdown.js', 'shared\note-format.js',
    'shared\settings.js', 'shared\tts.js', 'shared\tts-worker.js',
    'vendor\kokoro\kokoro.js', 'vendor\kokoro\transformers.min.js', 'vendor\kokoro\phonemizer.js',
    'vendor\kokoro\model\config.json', 'vendor\kokoro\model\tokenizer.json',
    'vendor\kokoro\model\tokenizer_config.json', 'vendor\kokoro\model\onnx\model_fp16.onnx',
    'vendor\kokoro\voices\af_bella.bin', 'vendor\kokoro\ort\ort-wasm-simd-threaded.jsep.mjs',
    'vendor\kokoro\ort\ort-wasm-simd-threaded.jsep.wasm', 'vendor\kokoro\VERSION',
    'vendor\kokoro\LICENSE.kokoro-js', 'vendor\kokoro\LICENSE.huggingface-transformers',
    'vendor\kokoro\LICENSE.phonemizer', 'vendor\kokoro\LICENSE.onnxruntime'
)
$requiredFiles = @($binaries | ForEach-Object { Join-Path $sourcePath $_ })
$requiredFiles += @($requiredAssets | ForEach-Object { Join-Path $assets $_ })
$requiredFiles += @(
    (Join-Path $projectRoot 'sumatrapdf\COPYING'),
    (Join-Path $projectRoot 'sumatrapdf\COPYING.BSD'),
    (Join-Path $PSScriptRoot 'uninstall-local.ps1')
)
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) {
        throw "Required installation file is missing or empty: $file"
    }
}

$running = @(Get-CimInstance Win32_Process -Filter "Name='SumatraPDF.exe'" | Where-Object {
    $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $exePath, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count) { throw 'Close SumatraPDF AI before installing this build. The existing SumatraPDF may stay open.' }

if (Test-Path -LiteralPath $InstallPath) {
    $target = Get-Item -LiteralPath $InstallPath
    if (-not $target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The installation target must be an ordinary directory.'
    }
    if (Test-Path -LiteralPath $markerPath) {
        $previous = Get-Content -Raw -Encoding UTF8 -LiteralPath $markerPath | ConvertFrom-Json
        if ($previous.AppId -ne 'SumatraPDF.AI.Local' -or -not [string]::Equals($previous.InstallPath, $InstallPath, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The existing installation marker does not match this application.'
        }
    } elseif (@(Get-ChildItem -LiteralPath $InstallPath -Force).Count) {
        throw 'The installation target contains unrecognized files. Choose an empty directory under LocalAppData\Programs.'
    }
}

New-Item -ItemType Directory -Path $InstallPath, $dataPath -Force | Out-Null
$shortcuts = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SumatraPDF AI.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'SumatraPDF AI.lnk')
)
$installInfo = @{ AppId = 'SumatraPDF.AI.Local'; InstallPath = $InstallPath; DataPath = $dataPath; Version = '1.0.0' }
[IO.File]::WriteAllText($markerPath, ($installInfo | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

foreach ($binary in $binaries) {
    Copy-Item -LiteralPath (Join-Path $sourcePath $binary) -Destination (Join-Path $InstallPath $binary) -Force
}
$installedAssets = Join-Path $InstallPath 'notes'
New-Item -ItemType Directory -Path $installedAssets -Force | Out-Null
Get-ChildItem -LiteralPath $assets -Force | Copy-Item -Destination $installedAssets -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'sumatrapdf\COPYING'), (Join-Path $projectRoot 'sumatrapdf\COPYING.BSD') -Destination $InstallPath -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-local.ps1') -Destination $InstallPath -Force

$settingsPath = Join-Path $dataPath 'SumatraPDF-settings.txt'
if (-not (Test-Path -LiteralPath $settingsPath)) {
    $previous = Select-SumatraHistorySource
    $settingsText = if ($previous) { $previous.Config.Text } else { '' }
    $defaults = @{
        RestoreSession = 'false'; ShowStartPage = 'true'; RememberOpenedFiles = 'true';
        UseTabs = 'true'; CheckForUpdates = 'false'; SelectionToolbar = 'true'
    }
    foreach ($setting in $defaults.GetEnumerator()) {
        $line = "$($setting.Key) = $($setting.Value)"
        if ($settingsText -match "(?m)^$($setting.Key)\s*=") {
            $settingsText = [regex]::Replace($settingsText, "(?m)^$($setting.Key)\s*=.*$", $line)
        } else {
            $settingsText += "`r`n$line`r`n"
        }
    }
    [IO.File]::WriteAllText($settingsPath, $settingsText, (New-Object Text.UTF8Encoding($false)))
}

$shell = New-Object -ComObject WScript.Shell
$arguments = '-appdata "' + $dataPath + '"'
foreach ($link in $shortcuts) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $link) -Force | Out-Null
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $exePath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $InstallPath
    $shortcut.Description = 'SumatraPDF AI notes and reading history'
    $shortcut.IconLocation = "$exePath,0"
    $shortcut.Save()
}

$progId = 'SumatraPDF.AI.PDF'
$progIdKey = "HKCU:\Software\Classes\$progId"
$openCommand = '"' + $exePath + '" ' + $arguments + ' "%1"'
$icon = '"' + $exePath + '",0'
foreach ($key in @($progIdKey, "$progIdKey\Application", "$progIdKey\DefaultIcon", "$progIdKey\shell\open\command")) {
    New-Item -Path $key -Force | Out-Null
}
Set-Item -LiteralPath $progIdKey -Value 'SumatraPDF AI PDF'
New-ItemProperty -Path $progIdKey -Name FriendlyAppName -Value 'SumatraPDF AI' -PropertyType String -Force | Out-Null
New-ItemProperty -Path "$progIdKey\Application" -Name ApplicationName -Value 'SumatraPDF AI' -PropertyType String -Force | Out-Null
New-ItemProperty -Path "$progIdKey\Application" -Name ApplicationDescription -Value 'PDF reader with AI notes and searchable reading history' -PropertyType String -Force | Out-Null
New-ItemProperty -Path "$progIdKey\Application" -Name ApplicationIcon -Value $icon -PropertyType String -Force | Out-Null
Set-Item -LiteralPath "$progIdKey\DefaultIcon" -Value $icon
Set-Item -LiteralPath "$progIdKey\shell\open\command" -Value $openCommand
$openWith = 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
New-Item -Path $openWith -Force | Out-Null
New-ItemProperty -Path $openWith -Name $progId -Value '' -PropertyType String -Force | Out-Null
$capabilitiesPath = 'Software\SumatraPDF-AI\Capabilities'
$capabilitiesKey = 'HKCU:\' + $capabilitiesPath
New-Item -Path "$capabilitiesKey\FileAssociations" -Force | Out-Null
New-ItemProperty -Path $capabilitiesKey -Name ApplicationName -Value 'SumatraPDF AI' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $capabilitiesKey -Name ApplicationDescription -Value 'PDF reader with AI notes and searchable reading history' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $capabilitiesKey -Name ApplicationIcon -Value $icon -PropertyType String -Force | Out-Null
New-ItemProperty -Path "$capabilitiesKey\FileAssociations" -Name '.pdf' -Value $progId -PropertyType String -Force | Out-Null
$registeredApps = 'HKCU:\Software\RegisteredApplications'
New-Item -Path $registeredApps -Force | Out-Null
New-ItemProperty -Path $registeredApps -Name 'SumatraPDF AI' -Value $capabilitiesPath -PropertyType String -Force | Out-Null
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

$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SumatraPDF-AI'
New-Item -Path $registration -Force | Out-Null
$properties = @{
    DisplayName = 'SumatraPDF AI'; DisplayVersion = '1.0.0'; Publisher = 'Local build';
    InstallLocation = $InstallPath; DisplayIcon = $exePath;
    UninstallString = ('powershell.exe -NoProfile -File "' + (Join-Path $InstallPath 'uninstall-local.ps1') + '"')
}
foreach ($property in $properties.GetEnumerator()) {
    New-ItemProperty -Path $registration -Name $property.Key -Value $property.Value -PropertyType String -Force | Out-Null
}
New-ItemProperty -Path $registration -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $registration -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
Write-Output "Installed: $exePath"
Write-Output "Data: $dataPath"
if ($Launch) { Start-Process -FilePath $exePath -ArgumentList $arguments -WindowStyle Normal }
