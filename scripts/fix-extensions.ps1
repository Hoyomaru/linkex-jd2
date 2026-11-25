<#
.SYNOPSIS
  フォルダ内のファイルの中身（先頭バイト）を見て、拡張子が無い・間違っているものを正しい拡張子にリネームする。

  対象は PowerShell で今いるフォルダ（cd した先）。-Path を付ければ別のフォルダも指定できる。

.EXAMPLE
  cd <調べたいフォルダ>

  # まず確認だけ（何もリネームしない）
  <このリポジトリ>\scripts\fix-extensions.ps1

  # 実際にリネームする
  <このリポジトリ>\scripts\fix-extensions.ps1 -Apply

  # サブフォルダも対象にする
  <このリポジトリ>\scripts\fix-extensions.ps1 -Recurse -Apply
#>
param(
    [string]$Path = (Get-Location).Path,
    [switch]$Recurse,
    [switch]$Apply
)

# 種類ごとに「付ける拡張子」と「正しいとみなす拡張子」
$Types = @{
    jpg  = @('.jpg', '.jpeg', '.jfif', '.jpe')
    png  = @('.png')
    gif  = @('.gif')
    webp = @('.webp')
    bmp  = @('.bmp')
    avif = @('.avif')
    heic = @('.heic', '.heif')
    mp4  = @('.mp4', '.m4v')
    mov  = @('.mov', '.qt')
    m4a  = @('.m4a')
    webm = @('.webm')
    mkv  = @('.mkv')
    avi  = @('.avi')
    flv  = @('.flv')
    ts   = @('.ts', '.m2ts', '.mts')
    mp3  = @('.mp3')
    wav  = @('.wav')
    pdf  = @('.pdf')
    zip  = @('.zip')
}

$KnownExts = @($Types.Values | ForEach-Object { $_ }) + @('.jpeg', '.tif', '.tiff', '.mpg', '.mpeg', '.wmv', '.3gp', '.html', '.htm', '.xml', '.txt', '.bin', '.dat', '.tmp', '.part')

function Get-Ascii([byte[]]$b, [int]$start, [int]$len) {
    if ($b.Length -lt $start + $len) { return '' }
    return [System.Text.Encoding]::ASCII.GetString($b, $start, $len)
}

function Get-DetectedType([string]$file) {
    $buf = New-Object byte[] 4096
    $fs = [System.IO.File]::OpenRead($file)
    try { $n = $fs.Read($buf, 0, $buf.Length) } finally { $fs.Dispose() }
    if ($n -lt 4) { return $null }
    $b = $buf[0..($n - 1)]

    if ($b[0] -eq 0xFF -and $b[1] -eq 0xD8 -and $b[2] -eq 0xFF) { return 'jpg' }
    if ((Get-Ascii $b 1 3) -eq 'PNG' -and $b[0] -eq 0x89) { return 'png' }
    if ((Get-Ascii $b 0 4) -eq 'GIF8') { return 'gif' }
    if ((Get-Ascii $b 0 2) -eq 'BM' -and $n -ge 26) { return 'bmp' }
    if ((Get-Ascii $b 0 4) -eq '%PDF') { return 'pdf' }
    if ((Get-Ascii $b 0 4) -eq "PK$([char]3)$([char]4)") { return 'zip' }
    if ((Get-Ascii $b 0 3) -eq 'FLV') { return 'flv' }
    if ((Get-Ascii $b 0 3) -eq 'ID3') { return 'mp3' }

    if ((Get-Ascii $b 0 4) -eq 'RIFF') {
        switch (Get-Ascii $b 8 4) {
            'WEBP' { return 'webp' }
            'AVI ' { return 'avi' }
            'WAVE' { return 'wav' }
        }
    }

    if ((Get-Ascii $b 4 4) -eq 'ftyp') {
        $brand = Get-Ascii $b 8 4
        switch -regex ($brand) {
            '^qt  $'                 { return 'mov' }
            '^(avif|avis)$'          { return 'avif' }
            '^(heic|heix|hevc|mif1|msf1)$' { return 'heic' }
            '^M4A '                  { return 'm4a' }
            default                  { return 'mp4' }
        }
    }

    if ($b[0] -eq 0x1A -and $b[1] -eq 0x45 -and $b[2] -eq 0xDF -and $b[3] -eq 0xA3) {
        $head = [System.Text.Encoding]::ASCII.GetString($b)
        if ($head.Contains('webm')) { return 'webm' } else { return 'mkv' }
    }

    # MPEG-TS: 188 バイトごとに 0x47
    if ($n -ge 377 -and $b[0] -eq 0x47 -and $b[188] -eq 0x47 -and $b[376] -eq 0x47) { return 'ts' }

    # ID3 タグなし MP3（フレーム同期）
    if ($b[0] -eq 0xFF -and ($b[1] -band 0xE0) -eq 0xE0) { return 'mp3' }

    return $null
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    Write-Error "フォルダが見つかりません: $Path"
    exit 1
}

$files = Get-ChildItem -LiteralPath $Path -File -Recurse:$Recurse
$fixed = 0; $unknown = 0; $ok = 0

foreach ($f in $files) {
    try { $type = Get-DetectedType $f.FullName }
    catch { Write-Warning "読めませんでした: $($f.FullName) ($($_.Exception.Message))"; continue }

    $ext = $f.Extension.ToLower()
    if (-not $type) {
        # 中身から判定できないものは、拡張子が無いときだけ知らせる
        if ($ext -eq '') { Write-Host "? 判定できず: $($f.Name)" -ForegroundColor DarkYellow; $unknown++ }
        continue
    }
    if ($Types[$type] -contains $ext) { $ok++; continue }

    # 知っている拡張子が間違っていれば差し替える。それ以外（無い・"video.2024" の ".2024" など）は付け足す
    $base = if ($KnownExts -contains $ext) { [System.IO.Path]::GetFileNameWithoutExtension($f.Name) } else { $f.Name }
    $newName = "$base.$type"
    $i = 1
    while (Test-Path -LiteralPath (Join-Path $f.DirectoryName $newName)) {
        $newName = "$base ($i).$type"; $i++
    }

    if ($Apply) {
        Rename-Item -LiteralPath $f.FullName -NewName $newName
        Write-Host "リネーム: $($f.Name) -> $newName" -ForegroundColor Green
    } else {
        Write-Host "予定: $($f.Name) -> $newName" -ForegroundColor Cyan
    }
    $fixed++
}

Write-Host ''
$verb = if ($Apply) { 'リネームした' } else { 'リネーム予定' }
Write-Host "${verb}: $fixed 件 / 拡張子が正しい: $ok 件 / 判定できず: $unknown 件"
if (-not $Apply -and $fixed -gt 0) {
    Write-Host '確認だけしました。実際にリネームするには -Apply を付けて実行してください。' -ForegroundColor Yellow
}
