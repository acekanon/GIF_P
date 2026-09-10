param(
  [string]$PackageRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$expectedVersion = "__GIFP_VERSION__"
$expectedChannel = "__GIFP_CHANNEL__"
$expectedRedistributable = [System.Convert]::ToBoolean("__GIFP_REDISTRIBUTABLE__")
$allowedSignerThumbprint = "__GIFP_ALLOWED_SIGNER_THUMBPRINT__".Replace(" ", "").ToLowerInvariant()
$authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
if (!$authenticodeCommand) {
  # Resolve the Windows inbox module explicitly. PSModulePath may also contain
  # a PowerShell 7 module with the same name, which Windows PowerShell cannot
  # safely import.
  $securityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
  Import-Module $securityModule -ErrorAction Stop
  $authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction Stop
}

function Fail([string]$Message) {
  Write-Host "[FAIL] $Message" -ForegroundColor Red
  exit 1
}

function Get-Sha256([string]$LiteralPath) {
  $stream = [IO.File]::OpenRead($LiteralPath)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

try {
  $root = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $manifestPath = Join-Path $root "FILES-SHA256.txt"
  $distributionPath = Join-Path $root "DISTRIBUTION.json"
  if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail "FILES-SHA256.txt is missing." }
  if (!(Test-Path -LiteralPath $distributionPath -PathType Leaf)) { Fail "DISTRIBUTION.json is missing." }

  $expectedFiles = @{}
  foreach ($line in Get-Content -LiteralPath $manifestPath) {
    if (!$line) { continue }
    if ($line -notmatch '^([a-fA-F0-9]{64})  (.+)$') { Fail "FILES-SHA256.txt contains an invalid line." }
    $relativePath = $Matches[2].Replace("/", "\")
    if ([IO.Path]::IsPathRooted($relativePath) -or $relativePath.Split("\") -contains "..") {
      Fail "FILES-SHA256.txt contains an unsafe path: $relativePath"
    }
    if ($expectedFiles.ContainsKey($relativePath)) { Fail "FILES-SHA256.txt contains a duplicate path: $relativePath" }
    $expectedFiles[$relativePath] = $Matches[1].ToLowerInvariant()
  }

  $actualFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object {
    $_.FullName.Substring($root.Length + 1)
  } | Where-Object { $_ -cne "FILES-SHA256.txt" })
  if ($actualFiles.Count -ne $expectedFiles.Count) { Fail "Packaged file count does not match FILES-SHA256.txt." }
  foreach ($relativePath in $actualFiles) {
    if (!$expectedFiles.ContainsKey($relativePath)) { Fail "Unlisted packaged file: $relativePath" }
    $actualHash = Get-Sha256 (Join-Path $root $relativePath)
    if ($actualHash -ne $expectedFiles[$relativePath]) { Fail "SHA-256 mismatch: $relativePath" }
  }

  $distribution = Get-Content -Raw -LiteralPath $distributionPath | ConvertFrom-Json
  if ([string]$distribution.product.version -cne $expectedVersion) { Fail "DISTRIBUTION version does not match this package." }
  if ([string]$distribution.product.channel -cne $expectedChannel) { Fail "DISTRIBUTION channel does not match this package." }
  if ([bool]$distribution.distribution.redistributable -ne $expectedRedistributable) { Fail "DISTRIBUTION redistributable state does not match this package." }

  $applicationName = [string]$distribution.application.fileName
  if ([IO.Path]::GetFileName($applicationName) -cne $applicationName -or [IO.Path]::GetExtension($applicationName) -ine ".exe") {
    Fail "DISTRIBUTION application file name is invalid."
  }
  $applicationPath = Join-Path $root $applicationName
  if (!(Test-Path -LiteralPath $applicationPath -PathType Leaf)) { Fail "Application executable is missing." }
  $applicationHash = Get-Sha256 $applicationPath
  if ($applicationHash -ne ([string]$distribution.application.sha256).ToLowerInvariant()) { Fail "Application SHA-256 does not match DISTRIBUTION." }

  $signature = & $authenticodeCommand -LiteralPath $applicationPath
  $actualStatus = [string]$signature.Status
  $actualThumbprint = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToLowerInvariant()
  } else { "" }
  if ($actualStatus -cne [string]$distribution.application.signatureStatus) { Fail "Authenticode status does not match DISTRIBUTION." }
  $recordedThumbprint = ([string]$distribution.application.signerThumbprint).Replace(" ", "").ToLowerInvariant()
  if ($actualThumbprint -cne $recordedThumbprint) { Fail "Authenticode signer does not match DISTRIBUTION." }

  if ($expectedChannel -eq "public") {
    if (!$expectedRedistributable) { Fail "Formal public package must be redistributable." }
    if ($actualStatus -cne "Valid") { Fail "Formal public package requires a Valid Authenticode signature." }
    if ($allowedSignerThumbprint -notmatch '^[a-f0-9]{40,64}$') { Fail "Formal public package has no embedded allowlisted signer." }
    if ($actualThumbprint -cne $allowedSignerThumbprint) { Fail "Authenticode signer is not allowlisted for this GIFP release." }
  } elseif ($expectedChannel -eq "public-alpha") {
    if (!$expectedRedistributable) { Fail "Public Alpha package must be redistributable." }
    if ($actualStatus -eq "Valid" -and $allowedSignerThumbprint -and $actualThumbprint -cne $allowedSignerThumbprint) {
      Fail "Signed Public Alpha signer is not allowlisted."
    }
  } elseif ($expectedChannel -eq "internal") {
    if ($expectedRedistributable) { Fail "Internal package must not be redistributable." }
  } else {
    Fail "Unsupported embedded distribution channel."
  }

  Write-Host "[PASS] FILES-SHA256: $($expectedFiles.Count) packaged files verified." -ForegroundColor Green
  Write-Host "[PASS] DISTRIBUTION: GIFP $expectedVersion / $expectedChannel / redistributable=$($expectedRedistributable.ToString().ToLowerInvariant())." -ForegroundColor Green
  Write-Host "[PASS] Authenticode: $actualStatus$(if ($actualThumbprint) { " / $actualThumbprint" })." -ForegroundColor Green
  Write-Host "[PASS] GIFP package verification completed." -ForegroundColor Green
  exit 0
} catch {
  Fail $_.Exception.Message
}
