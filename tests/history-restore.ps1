$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $projectRoot 'scripts\history-config.psm1') -Force -DisableNameChecking

function Assert-HistoryTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}
function Assert-HistoryThrows {
    param([scriptblock]$Action, [string]$Message)
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert-HistoryTest $failed $Message
}
function Get-HistoryOutside {
    param([string]$Text)
    $info = Get-SumatraHistoryInfo -Text $Text
    if (-not $info.Section) { return $Text }
    return $Text.Substring(0,$info.Section.Start) + '<history>' + $Text.Substring($info.Section.End)
}

$current = @'
Language = en
CustomAiOption = keep
FileStates [
  [
    FilePath = C:\Docs\Shared.pdf
    OpenCount = 99
    LastOpened = 1794360000000
    Favorites [
      [
        Name = AI favorite [kept] = yes
        PageNo = 8
      ]
    ]
  ]
  [
    FilePath = c:\docs\shared.PDF
    OpenCount = 0
  ]
]
SessionData [
  [
    FilePath = C:\session-only.pdf
    Pinned = true
  ]
]
'@
$source = @'
Language = zh-CN
FileStates [
  [
    FilePath = C:\DOCS\SHARED.pdf
    OpenCount = 1
  ]
  [
    FilePath = G:\资料\[A=B]\说明.pdf
    OpenCount = 7
    Favorites [ # Nested bookmarks must stay intact.
      [
        Name = Source favorite ] = 中文
        FilePath = X:\nested-only.pdf
        PageNo = 3
      ]
    ]
  ]
  [
    FilePath = g:\资料\[a=b]\说明.PDF
    OpenCount = 2
  ]
  [
    FilePath = D:\new\[] = #; 文档.pdf
    PageNo = 4
  ]
]
SessionData [
  [
    FilePath = D:\source-session-only.pdf
  ]
]
'@
$merged = Merge-SumatraHistory -CurrentText $current -SourceText $source
Assert-HistoryTest ($merged.SourceCount -eq 4 -and $merged.CurrentCount -eq 2) 'FileStates counting included nested or session paths.'
Assert-HistoryTest ($merged.Merged -eq 3 -and $merged.Added -eq 2 -and $merged.Overlap -eq 1) 'Merge summary is incorrect.'
Assert-HistoryTest ($merged.SourceDuplicates -eq 1 -and $merged.CurrentDuplicates -eq 1) 'Case-insensitive duplicate handling failed.'
Assert-HistoryTest ((Get-HistoryOutside $current) -ceq (Get-HistoryOutside $merged.Text)) 'AI settings or session changed outside FileStates.'
$after = Get-SumatraHistoryInfo -Text $merged.Text
Assert-HistoryTest ($after.Entries[0].Raw.Contains('OpenCount = 99')) 'AI state was not preferred.'
Assert-HistoryTest ($after.Entries[0].Raw.Contains('AI favorite [kept] = yes')) 'AI nested Favorites were changed.'
Assert-HistoryTest ($after.Entries[1].Raw.Contains('Source favorite ] = 中文')) 'Source nested Favorites were lost.'
Assert-HistoryTest ($after.Entries[1].Path -ceq 'G:\资料\[A=B]\说明.pdf') 'Brackets, equals or Unicode in FilePath were parsed as structure.'
Assert-HistoryTest ($after.Entries[2].Path -ceq 'D:\new\[] = #; 文档.pdf') 'Comment characters in FilePath were truncated.'
$again = Merge-SumatraHistory -CurrentText $merged.Text -SourceText $source
Assert-HistoryTest (-not $again.Changed -and $again.Added -eq 0) 'Merge is not idempotent.'
Assert-HistoryTest (-not (Merge-SumatraHistory -CurrentText '' -SourceText '').Changed) 'Empty configurations changed unnecessarily.'
Assert-HistoryTest ((Merge-SumatraHistory -CurrentText 'Language = en' -SourceText $source).Merged -eq 3) 'Missing target history section was not created.'
Assert-HistoryThrows { Merge-SumatraHistory -CurrentText $current -SourceText "FileStates [`n  [`n    FilePath = C:\broken.pdf" } 'Incomplete source block was accepted.'
Assert-HistoryThrows { Merge-SumatraHistory -CurrentText "FileStates [`n" -SourceText $source } 'Incomplete AI block was accepted.'
Assert-HistoryThrows { Get-SumatraHistoryInfo -Text "FileStates [`n [`n FilePath = `n ]`n]" } 'Empty FilePath was accepted.'
Assert-HistoryThrows { Get-SumatraHistoryInfo -Text ([string][char]0) } 'NUL-damaged text was accepted.'

$fixtureRoot = Join-Path $projectRoot ('.test-artifacts\history-restore-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$sourcePath = Join-Path $fixtureRoot 'source.txt'
$targetPath = Join-Path $fixtureRoot 'target.txt'
$emptyPath = Join-Path $fixtureRoot 'newer-empty.txt'
$backups = Join-Path $fixtureRoot 'backups'
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($sourcePath,$source,$utf8)
[IO.File]::WriteAllText($targetPath,$current,$utf8)
[IO.File]::WriteAllText($emptyPath,'Language = en',$utf8)
[IO.File]::SetLastWriteTimeUtc($sourcePath,[datetime]::UtcNow.AddDays(-1))
[IO.File]::SetLastWriteTimeUtc($emptyPath,[datetime]::UtcNow)
$selected = Select-SumatraHistorySource -Paths @($emptyPath,$sourcePath)
Assert-HistoryTest ($selected.Config.Path -eq $sourcePath) 'A newer empty configuration displaced real history.'
$malformedPath = Join-Path $fixtureRoot 'malformed.txt'
[IO.File]::WriteAllText($malformedPath,'FileStates [',$utf8)
Assert-HistoryTest ((Select-SumatraHistorySource -Paths @($malformedPath,$sourcePath)).Config.Path -eq $sourcePath) 'A damaged candidate displaced valid history.'
Assert-HistoryThrows { Select-SumatraHistorySource -Paths @($malformedPath) } 'A set of only damaged candidates was accepted.'
$notesPath = Join-Path $fixtureRoot 'context-notes.dat'
[byte[]]$opaqueNotes = @(0,255,23,0,17,91,188,42,19)
[IO.File]::WriteAllBytes($notesPath,$opaqueNotes)
$original = [IO.File]::ReadAllBytes($targetPath)
$preview = & (Join-Path $projectRoot 'scripts\restore-history.ps1') -SourceConfig $sourcePath -TargetConfig $targetPath -BackupRoot $backups -DryRun
Assert-HistoryTest ($preview.Merged -eq 3 -and $preview.Added -eq 2) 'Fixture dry-run summary failed.'
Assert-HistoryTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($targetPath)) -ceq [Convert]::ToBase64String($original)) 'Dry-run modified the target.'
Assert-HistoryTest (-not [IO.Directory]::Exists($backups)) 'Dry-run created backups or other files.'
$applied = & (Join-Path $projectRoot 'scripts\restore-history.ps1') -SourceConfig $sourcePath -TargetConfig $targetPath -BackupRoot $backups -Apply
Assert-HistoryTest ((Get-SumatraHistoryInfo -Text ([IO.File]::ReadAllText($targetPath))).Count -eq 3) 'Atomic apply produced incorrect history.'
Assert-HistoryTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($notesPath)) -ceq [Convert]::ToBase64String($opaqueNotes)) 'Opaque notes/key file was changed.'
Assert-HistoryTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $applied.BackupDirectory 'context-notes.dat'))) -ceq [Convert]::ToBase64String($opaqueNotes)) 'Opaque notes/key backup is not exact.'
Assert-HistoryTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $applied.BackupDirectory 'AI-settings-before.txt'))) -ceq [Convert]::ToBase64String($original)) 'AI settings backup is not exact.'
Assert-HistoryTest ([IO.File]::ReadAllText((Join-Path $applied.BackupDirectory 'Source-settings-original.txt')) -ceq $source) 'Source backup differs.'
[IO.File]::Copy((Join-Path $applied.BackupDirectory 'AI-settings-before.txt'),$targetPath,$true)
Assert-HistoryTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($targetPath)) -ceq [Convert]::ToBase64String($original)) 'Backup did not restore the original fixture exactly.'
$bomPath = Join-Path $fixtureRoot 'utf8-bom.txt'
[IO.File]::WriteAllText($bomPath,$current,(New-Object Text.UTF8Encoding($true)))
$bomApplied = & (Join-Path $projectRoot 'scripts\restore-history.ps1') -SourceConfig $sourcePath -TargetConfig $bomPath -BackupRoot $backups -Apply
$bomBytes = [IO.File]::ReadAllBytes($bomPath)
Assert-HistoryTest ($bomBytes[0] -eq 239 -and $bomBytes[1] -eq 187 -and $bomBytes[2] -eq 191) 'UTF-8 BOM was changed.'
Assert-HistoryTest ((Read-SumatraConfig -Path $bomPath).Text -ceq $merged.Text) 'BOM configuration merge changed text.'
Write-Output 'PASS: nested Favorites, special paths, deduplication, AI priority, unchanged settings/session, empty/damaged inputs, source choice, dry-run, atomic apply, exact backups and opaque notes preservation.'
