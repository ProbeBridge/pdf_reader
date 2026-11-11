param(
    [ValidateSet('rel', 'dbg')][string]$Configuration = 'rel',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot '.tools'
$repository = Join-Path $projectRoot 'sumatrapdf'
$toolchainPath = Join-Path $toolsRoot 'toolchain.json'
if (Test-Path -LiteralPath $toolchainPath) {
    $toolchain = Get-Content -Raw -Encoding UTF8 -LiteralPath $toolchainPath | ConvertFrom-Json
    $env:PATH = "$(Join-Path $toolchain.msvc 'bin\Hostx64\x64');$(Join-Path $toolchain.sdk "bin\$($toolchain.sdkVersion)\x64");$(Join-Path $toolsRoot 'node_modules\.bin');$(Join-Path $toolsRoot 'python\clang_format\data\bin');$(Join-Path $toolsRoot 'python\bin');$env:PATH;C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64"
    $env:INCLUDE = "$(Join-Path $toolchain.msvc 'include');$(Join-Path $toolchain.sdk "Include\$($toolchain.sdkVersion)\ucrt");$(Join-Path $toolchain.sdk "Include\$($toolchain.sdkVersion)\shared");$(Join-Path $toolchain.sdk "Include\$($toolchain.sdkVersion)\um");$(Join-Path $toolchain.sdk "Include\$($toolchain.sdkVersion)\winrt")"
    $env:LIB = "$(Join-Path $toolchain.msvc 'lib\x64');$(Join-Path $toolchain.sdk "Lib\$($toolchain.sdkVersion)\ucrt\x64");$(Join-Path $toolchain.sdk "Lib\$($toolchain.sdkVersion)\um\x64")"
    $env:VCToolsInstallDir = $toolchain.msvc + '\'
    $env:VCToolsVersion = Split-Path -Leaf $toolchain.msvc
    $env:WindowsSDKVersion = $toolchain.sdkVersion + '\'
} elseif (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw 'Open a Visual Studio x64 Developer PowerShell, or configure .tools/toolchain.json for a local MSVC and Windows SDK.'
}
$env:PATH = "$(Join-Path $projectRoot 'node_modules\.bin');$(Join-Path $toolsRoot 'node_modules\.bin');$env:PATH"
$bunCommand = Get-Command (Join-Path $toolsRoot 'node_modules\.bin\bun.cmd') -ErrorAction SilentlyContinue
if (-not $bunCommand) { $bunCommand = Get-Command bun.exe -ErrorAction SilentlyContinue }
if (-not $bunCommand) { $bunCommand = Get-Command bun.cmd -ErrorAction SilentlyContinue }
if (-not $bunCommand) { throw 'Bun is required. Run npm ci or install Bun before building.' }
$env:VSLANG = '1033'
$env:CL = '/FI"' + (Join-Path $PSScriptRoot 'msvc-compat.h') + '"'
$formatSources = @(
    'src/ContextNotes.cpp', 'src/ContextNotes.h',
    'src/ContextNoteOverlay.cpp', 'src/ContextNoteOverlay.h',
    'src/ContextNotesNetwork.cpp', 'src/ContextNotesNetwork.h',
    'src/ReflowDocument.cpp', 'src/ReflowDocument.h',
    'src/Canvas.cpp', 'src/CanvasAboutUI.cpp', 'src/CustomZoomDialog.cpp',
    'src/MainWindow.cpp', 'src/MainWindow.h', 'src/Menu.cpp',
    'src/Settings.cpp', 'src/Settings.h', 'src/SidebarPanel.cpp',
    'src/SumatraControl.cpp', 'src/SumatraPDF.cpp', 'src/TableOfContents.cpp',
    'src/Toolbar.cpp', 'src/base/Http.cpp', 'src/base/Http.h',
    'src/shared/Accelerators.cpp', 'src/shared/AppSettings.cpp', 'src/shared/AppSettings.h',
    'src/shared/CommandAvailability.cpp', 'src/shared/Commands.cpp', 'src/shared/Commands.h',
    'src/shared/EngineBase.cpp', 'src/shared/EngineBase.h',
    'src/shared/EngineMupdf.cpp', 'src/shared/EngineMupdf.h',
    'src/shared/FileHistory.cpp', 'src/shared/MenuDefs.cpp',
    'src/shared/SelectionToolbarCommon.cpp', 'src/shared/SumatraPDFCommon.cpp',
    'src/shared/TableOfContents.h', 'src/shared/ToolbarCommon.cpp',
    'src/uia/Constants.h', 'src/uia/PageProvider.cpp', 'src/uia/TextRange.cpp'
)

Push-Location -LiteralPath $repository
try {
    & clang-format -i @formatSources
    if ($LASTEXITCODE) { throw 'clang-format failed' }
    $buildArguments = @('cmd/build.ts', "-$Configuration", '-ninja')
    if ($Clean) {
        $expectedOutput = [IO.Path]::GetFullPath((Join-Path $repository "out\$($Configuration)64"))
        if (-not $expectedOutput.StartsWith([IO.Path]::GetFullPath((Join-Path $repository 'out')) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected build output path.' }
        if (Test-Path -LiteralPath $expectedOutput) {
            if ((Resolve-Path -LiteralPath $expectedOutput).Path -ne $expectedOutput) { throw 'Build output is redirected.' }
        }
        $buildArguments += '-clean'
    }
    $ErrorActionPreference = 'Continue'
    & $bunCommand.Source @buildArguments
    $buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($buildExitCode) { throw 'SumatraPDF build failed' }
} finally {
    Pop-Location
}
