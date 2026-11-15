# Perafly CLI kurulum betiği, Windows x64 (README §8).
#
#   irm https://github.com/perafly/perafly-cli/releases/latest/download/install.ps1 | iex
#
# Tek dosya ikiliyi ve SHA256SUMS'u indirir, SHA-256 özetini doğrular (uymazsa hiçbir şey kurmaz), $HOME\.perafly\bin'e
# kurar ve PATH talimatı verir. Yönetici izni istemez, PATH'i kendisi değiştirmez; belirteç ya da kişisel veri göndermez.
# Ortam değişkenleri install.sh ile aynıdır: PERAFLY_VERSION, PERAFLY_INSTALL_DIR, PERAFLY_DOWNLOAD_BASE,
# PERAFLY_REPOSITORY.

# packaging/release.json "repository" ile aynı olmalı (test/release.test.ts denetler)
$DefaultRepository = 'perafly/perafly-cli'

function Install-Perafly {
    $ErrorActionPreference = 'Stop'
    $arch = $env:PROCESSOR_ARCHITECTURE
    # ARM64 Windows x64 ikiliyi öykünmeyle çalıştırır
    if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') { throw "unsupported CPU: $arch. Run npm install -g perafly (Node 22+)." }
    $asset = 'perafly-windows-x64.exe'

    $version = if ($env:PERAFLY_VERSION) { $env:PERAFLY_VERSION -replace '^v', '' } else { 'latest' }
    if ($version -ne 'latest' -and $version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'PERAFLY_VERSION must look like 1.2.3' }
    $repository = if ($env:PERAFLY_REPOSITORY) { $env:PERAFLY_REPOSITORY } else { $DefaultRepository }
    if ($repository -notmatch '^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$') { throw 'PERAFLY_REPOSITORY must be owner/name' }
    if ($env:PERAFLY_DOWNLOAD_BASE) { $base = $env:PERAFLY_DOWNLOAD_BASE.TrimEnd('/') }
    elseif ($version -eq 'latest') { $base = "https://github.com/$repository/releases/latest/download" }
    else { $base = "https://github.com/$repository/releases/download/v$version" }
    if ($base -notmatch '^https://' -and $base -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(/|$)') {
        throw 'PERAFLY_DOWNLOAD_BASE must use https (plain http is allowed only for localhost)'
    }
    $installDir = if ($env:PERAFLY_INSTALL_DIR) { $env:PERAFLY_INSTALL_DIR } else { Join-Path $HOME '.perafly\bin' }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('perafly-' + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Host "Downloading $asset ($version) from $base"
        $file = Join-Path $tmp $asset
        $sumsFile = Join-Path $tmp 'SHA256SUMS'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $file
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sumsFile

        $pattern = '^([0-9A-Fa-f]{64}) [ *]' + [regex]::Escape($asset) + '$'
        $lines = @(Get-Content $sumsFile | Where-Object { $_ -match $pattern })
        if ($lines.Count -ne 1) { throw "SHA256SUMS has no single entry for $asset. Nothing was installed." }
        $expected = $lines[0].Substring(0, 64).ToLowerInvariant()
        $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed." }
        Write-Host "Checksum verified (sha256 $actual)"

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        $staged = Join-Path $installDir ".perafly-install.$PID.exe"
        Copy-Item $file $staged -Force
        try {
            $got = "$(& $staged --version)".Trim()
            if ($LASTEXITCODE -ne 0) { throw 'the downloaded binary does not run on this machine. Nothing was installed.' }
            if ($version -ne 'latest' -and $got -ne $version) { throw "the downloaded binary is version $got, expected $version. Nothing was installed." }
            Move-Item $staged (Join-Path $installDir 'perafly.exe') -Force
        }
        finally {
            Remove-Item $staged -Force -ErrorAction SilentlyContinue
        }
        Write-Host "Installed perafly $got to $(Join-Path $installDir 'perafly.exe')"

        if (($env:Path -split ';') -notcontains $installDir) {
            Write-Host ''
            Write-Host "$installDir is not on your PATH. Add it for your user with:"
            Write-Host ''
            Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$installDir;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
            Write-Host ''
            Write-Host 'Then open a new terminal and run: perafly --help'
        }
        else { Write-Host 'Run: perafly --help' }
    }
    finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Perafly
