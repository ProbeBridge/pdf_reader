Set-StrictMode -Version 2

function Read-SumatraConfig {
    param([Parameter(Mandatory=$true)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $bytes = [IO.File]::ReadAllBytes($fullPath)
    $offset = 0
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        $offset = 3
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
        $encoding = New-Object Text.UnicodeEncoding($false, $false, $true)
        $offset = 2
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
        $encoding = New-Object Text.UnicodeEncoding($true, $false, $true)
        $offset = 2
    }
    $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    if ($text.IndexOf([char]0) -ge 0) { throw 'Configuration contains NUL bytes; no history can be restored safely.' }
    [byte[]]$preamble = @()
    if ($offset) { $preamble = $bytes[0..($offset-1)] }
    return [pscustomobject]@{
        Path = $fullPath; Text = $text; Bytes = $bytes; Encoding = $encoding;
        Preamble = $preamble; LastWriteTimeUtc = [IO.File]::GetLastWriteTimeUtc($fullPath)
    }
}

function New-HistoryTreeNode {
    param([string]$Name, [int]$Start, [int]$OpenEnd)
    return [pscustomobject]@{
        Name = $Name; Start = $Start; OpenEnd = $OpenEnd; CloseStart = -1; End = -1;
        Children = (New-Object 'Collections.Generic.List[object]');
        Values = (New-Object 'Collections.Generic.List[object]')
    }
}

function Get-SumatraHistoryInfo {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text)
    if ($Text.IndexOf([char]0) -ge 0) { throw 'Configuration contains NUL bytes.' }
    $root = New-HistoryTreeNode -Name '' -Start 0 -OpenEnd 0
    $stack = New-Object 'Collections.Generic.List[object]'
    $stack.Add($root)
    $lines = [regex]::Matches($Text, '[^\r\n]*(?:\r\n|\n|\r|$)')
    foreach ($line in $lines) {
        if (-not $line.Length) { continue }
        $body = $line.Value.TrimEnd([char[]]@([char]13, [char]10))
        $trimmed = $body.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#') -or $trimmed.StartsWith(';')) { continue }
        $value = [regex]::Match($body, '^\s*(?<key>[^=:\[\]\r\n]+?)\s*[=:]\s*(?<value>.*?)\s*$')
        if ($value.Success) {
            $stack[$stack.Count-1].Values.Add([pscustomobject]@{
                Key = $value.Groups['key'].Value.Trim(); Value = $value.Groups['value'].Value
            })
            continue
        }
        $open = [regex]::Match($body, '^\s*(?<name>[^=:\[\]\r\n]*?)\s*\[\s*(?:[#;].*)?$')
        if ($open.Success) {
            $node = New-HistoryTreeNode -Name $open.Groups['name'].Value.Trim() -Start $line.Index -OpenEnd ($line.Index+$line.Length)
            $stack[$stack.Count-1].Children.Add($node)
            $stack.Add($node)
            continue
        }
        if ($trimmed.StartsWith(']')) {
            $structure = [regex]::Replace($body, '[#;].*$', '')
            if ($structure -notmatch '^\s*(?:\]\s*)+(?:\[\s*)?$') { throw 'Malformed closing bracket in configuration.' }
            $tokens = [regex]::Matches($structure, '[\[\]]')
            $closedName = ''
            for ($i=0; $i -lt $tokens.Count; $i++) {
                $token = $tokens[$i]
                if ($token.Value -eq ']') {
                    if ($stack.Count -le 1) { throw 'Unmatched closing bracket in configuration.' }
                    $node = $stack[$stack.Count-1]
                    $node.CloseStart = if (-not $structure.Substring(0,$token.Index).Trim()) { $line.Index } else { $line.Index+$token.Index }
                    $node.End = if ($i -eq $tokens.Count-1) { $line.Index+$line.Length } else { $line.Index+$token.Index+1 }
                    $closedName = $node.Name
                    $stack.RemoveAt($stack.Count-1)
                } else {
                    $node = New-HistoryTreeNode -Name $closedName -Start ($line.Index+$token.Index) -OpenEnd ($line.Index+$line.Length)
                    $stack[$stack.Count-1].Children.Add($node)
                    $stack.Add($node)
                }
            }
            continue
        }
        throw 'Unsupported or damaged configuration line; no history can be restored safely.'
    }
    if ($stack.Count -ne 1) { throw 'Configuration has an incomplete block.' }
    $sections = @($root.Children | Where-Object { $_.Name -ieq 'FileStates' })
    if ($sections.Count -gt 1) { throw 'Multiple FileStates sections are ambiguous.' }
    $entries = New-Object 'Collections.Generic.List[object]'
    $section = if ($sections.Count) { $sections[0] } else { $null }
    if ($section) {
        if ($section.Values.Count) { throw 'FileStates contains values outside complete entries.' }
        foreach ($node in $section.Children) {
            $paths = @($node.Values | Where-Object { $_.Key -ieq 'FilePath' })
            if ($paths.Count -ne 1 -or [string]::IsNullOrWhiteSpace($paths[0].Value)) { throw 'A FileStates entry has no unique FilePath.' }
            $entries.Add([pscustomobject]@{ Path = $paths[0].Value; Raw = $Text.Substring($node.Start,$node.End-$node.Start) })
        }
    }
    return [pscustomobject]@{ Text = $Text; Section = $section; Entries = $entries; Count = $entries.Count }
}

function Select-SumatraHistorySource {
    param([string[]]$Paths)
    if (-not $Paths) {
        $Paths = @(
            (Join-Path $env:LOCALAPPDATA 'SumatraPDF\SumatraPDF-settings.txt'),
            (Join-Path $env:APPDATA 'SumatraPDF\SumatraPDF-settings.txt')
        )
    }
    $candidates = New-Object 'Collections.Generic.List[object]'
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $existing = 0
    foreach ($path in $Paths) {
        $fullPath = [IO.Path]::GetFullPath($path)
        if (-not $seen.Add($fullPath) -or -not [IO.File]::Exists($fullPath)) { continue }
        $existing++
        try {
            $config = Read-SumatraConfig -Path $fullPath
            $history = Get-SumatraHistoryInfo -Text $config.Text
            $candidates.Add([pscustomobject]@{ Config = $config; History = $history; HasHistory = $history.Count -gt 0 })
        } catch {
            continue
        }
    }
    if (-not $candidates.Count) {
        if ($existing) { throw 'Existing SumatraPDF configurations could not be parsed safely.' }
        return $null
    }
    return $candidates | Sort-Object @{Expression={$_.HasHistory};Descending=$true}, @{Expression={$_.Config.LastWriteTimeUtc};Descending=$true}, @{Expression={$_.History.Count};Descending=$true} | Select-Object -First 1
}

function Merge-SumatraHistory {
    param(
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$CurrentText,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$SourceText
    )
    $current = Get-SumatraHistoryInfo -Text $CurrentText
    $source = Get-SumatraHistoryInfo -Text $SourceText
    $merged = New-Object 'Collections.Generic.List[object]'
    $currentPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $sourcePaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $current.Entries) {
        if ($currentPaths.Add($entry.Path)) { $merged.Add($entry) }
    }
    $added = 0
    $overlap = 0
    foreach ($entry in $source.Entries) {
        if (-not $sourcePaths.Add($entry.Path)) { continue }
        if ($currentPaths.Contains($entry.Path)) { $overlap++; continue }
        $merged.Add($entry)
        $added++
    }
    $newText = $CurrentText
    if ($added -gt 0 -or $merged.Count -lt $current.Count) {
        $newline = if ($CurrentText.Contains("`r`n")) { "`r`n" } else { "`n" }
        $builder = New-Object Text.StringBuilder
        if ($current.Section) {
            [void]$builder.Append($CurrentText.Substring($current.Section.Start,$current.Section.OpenEnd-$current.Section.Start))
        } else { [void]$builder.Append('FileStates [' + $newline) }
        foreach ($entry in $merged) {
            [void]$builder.Append($entry.Raw.TrimEnd([char[]]@([char]13,[char]10)))
            [void]$builder.Append($newline)
        }
        if ($current.Section) {
            [void]$builder.Append($CurrentText.Substring($current.Section.CloseStart,$current.Section.End-$current.Section.CloseStart))
            $newText = $CurrentText.Substring(0,$current.Section.Start) + $builder.ToString() + $CurrentText.Substring($current.Section.End)
        } else {
            [void]$builder.Append(']' + $newline)
            $separator = if ($CurrentText.Length -and -not $CurrentText.EndsWith("`n") -and -not $CurrentText.EndsWith("`r")) { $newline } else { '' }
            $newText = $CurrentText + $separator + $builder.ToString()
        }
    }
    $validated = Get-SumatraHistoryInfo -Text $newText
    if ($validated.Count -ne $merged.Count) { throw 'Merged history failed validation.' }
    return [pscustomobject]@{
        Text = $newText; CurrentCount = $current.Count; SourceCount = $source.Count;
        Merged = $merged.Count; Added = $added; Overlap = $overlap;
        CurrentDuplicates = $current.Count-$currentPaths.Count; SourceDuplicates = $source.Count-$sourcePaths.Count;
        Changed = $newText -cne $CurrentText
    }
}

Export-ModuleMember -Function Read-SumatraConfig, Get-SumatraHistoryInfo, Select-SumatraHistorySource, Merge-SumatraHistory
