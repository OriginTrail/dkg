$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Microsoft documents this versioned Ubuntu 24.04 package for offline WSL
# installation: https://learn.microsoft.com/windows/wsl/install-manual
# Use its independent distribution endpoint instead of the live Ubuntu DNS
# dependency in `wsl --install --web-download`.
$url = 'https://wslstorestorage.blob.core.windows.net/wslblob/Ubuntu2404-240425.AppxBundle'
$sha256 = '510639de5934e003ffb5b5c4f91cfae6823fb75388c2464f7bc909baf4dc5dd6'
if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64' -or $env:GITHUB_ACTIONS -ne 'true') {
    throw 'The MCP WSL fixture requires a disposable Windows X64 Actions runner.'
}

function Expand-PinnedEntry([string]$Archive, [string]$EntryName, [string]$Destination) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $entry = $zip.GetEntry($EntryName)
        if ($null -eq $entry) { throw "Missing pinned archive entry: $EntryName" }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $Destination, $false)
    } finally {
        $zip.Dispose()
    }
}

$download = Join-Path $env:RUNNER_TEMP ('dkg-wsl-download-' + [guid]::NewGuid().ToString('N'))
$installation = Join-Path $env:RUNNER_TEMP 'dkg-mcp-ubuntu-2404'
[System.IO.Directory]::CreateDirectory($download) | Out-Null
try {
    $bundle = Join-Path $download 'Ubuntu2404.AppxBundle'
    curl.exe --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 600 --output $bundle $url
    if ($LASTEXITCODE -ne 0) { throw "Ubuntu WSL download failed: $LASTEXITCODE" }
    if ((Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
        throw 'Ubuntu WSL bundle checksum mismatch; refusing extraction and import.'
    }
    $appx = Join-Path $download 'Ubuntu-x64.appx'
    $rootfs = Join-Path $download 'install.tar.gz'
    Expand-PinnedEntry $bundle 'Ubuntu_2404.0.5.0_x64.appx' $appx
    Expand-PinnedEntry $appx 'install.tar.gz' $rootfs
    wsl --import Ubuntu-24.04 $installation $rootfs --version 2
    if ($LASTEXITCODE -ne 0) { throw "Ubuntu WSL import failed: $LASTEXITCODE" }
    $release = @(wsl --distribution Ubuntu-24.04 --user root --exec cat /etc/os-release)
    if ($LASTEXITCODE -ne 0 -or $release -notcontains 'ID=ubuntu' -or $release -notcontains 'VERSION_ID="24.04"') {
        throw 'Imported WSL distribution is not Ubuntu 24.04.'
    }
} finally {
    Remove-Item -LiteralPath $download -Recurse -Force
}
