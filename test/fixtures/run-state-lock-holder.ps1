param([Parameter(Mandatory=$true)][string]$Path, [int]$Milliseconds = 350)
$ErrorActionPreference = 'Stop'
# Permit reads/writes but deliberately omit FileShare.Delete. This is a real
# Windows sharing conflict with replacement, not a mocked EPERM exception.
$handle = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [System.Threading.Thread]::Sleep($Milliseconds)
} finally {
  $handle.Dispose()
}
