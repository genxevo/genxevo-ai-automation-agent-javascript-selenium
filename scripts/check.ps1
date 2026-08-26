#Requires -Version 5.1
<#
.SYNOPSIS
  The full local verification gate, for Windows. Mirrors scripts/check.sh.

.DESCRIPTION
  The stdout assertion is the point of this script existing separately: it proves
  that --version writes ZERO BYTES to stdout and that the banner IS on stderr.
  Testing only that stdout is empty would also pass for a server that printed
  nothing at all, which is a weaker guarantee than the one being made.

  TWO POWERSHELL FACTS SHAPE THIS SCRIPT, AND BOTH WERE FOUND BY RUNNING IT.

  1. `$ErrorActionPreference = 'Stop'` DOES NOT TRAP A NATIVE COMMAND'S EXIT
     CODE. It governs cmdlet errors. The first version of this script called
     `npm run lint`, `npm run format:check` and `npm run coverage` bare, so a
     failing lint set $LASTEXITCODE, the script carried on, and it printed
     ALL CHECKS PASSED in green. A verification gate that reports success after a
     failure is worse than no gate, so every native command now runs through
     `Invoke-Step`, which checks $LASTEXITCODE explicitly.

  2. REDIRECTING A NATIVE COMMAND'S STDERR IN POWERSHELL TURNS IT INTO A
     TERMINATING ERROR. `& node ... 2>$null` routes stderr through PowerShell's
     error stream, where it becomes a NativeCommandError and, under 'Stop',
     kills the script:

         node.exe : GenXEvo AI Automation Agent - JavaScript Selenium 0.1.0-alpha.1
         + $out = & node src/mcp/main.js --version 2>$null
         + FullyQualifiedErrorId : NativeCommandError

     That is exactly what this product's `--version` is SUPPOSED to do - write
     its banner to stderr - so the script was killed by the behaviour it exists
     to verify, and the three steps after it never ran. The bare `npm` calls
     above were unaffected only because nothing redirected their stderr.

     So the streams are captured with `Start-Process` and real files instead.
     PowerShell's stream plumbing is bypassed entirely, the byte count is read
     from the file rather than inferred from a string, and the semantics match
     `check.sh` exactly.
#>
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# A terminating error anywhere below lands here. Guarantees a non-zero exit code
# and guarantees that ALL CHECKS PASSED is never reached.
trap {
  Write-Host "CHECKS FAILED: $_" -ForegroundColor Red
  exit 1
}

function Step($name) { Write-Host "==> $name" -ForegroundColor Cyan }

# A native command's failure does NOT trip $ErrorActionPreference - that governs
# cmdlet errors only - so every npm and node invocation has its exit code
# checked explicitly. This function is the whole reason the gate is trustworthy.
function Invoke-Step($name, [scriptblock]$body) {
  Step $name
  & $body
  if ($LASTEXITCODE -ne 0) { throw "$name exited with code $LASTEXITCODE" }
}

# Run node with its two streams captured to files, so PowerShell never converts
# stderr into a terminating error. Returns the exit code, the exact BYTE COUNT
# written to stdout, and the text written to stderr.
function Invoke-NodeCaptured([string[]]$NodeArguments) {
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath 'node' -ArgumentList $NodeArguments `
      -WorkingDirectory (Get-Location).Path -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    return [pscustomobject]@{
      ExitCode    = $process.ExitCode
      StdoutBytes = (Get-Item $outFile).Length
      Stderr      = (Get-Content $errFile -Raw)
    }
  } finally {
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

Invoke-Step 'node version' { node --version }
Invoke-Step 'lint' { npm run lint }
Invoke-Step 'format' { npm run format:check }
Invoke-Step 'tests with enforced coverage' { npm run coverage }

Step 'stdout purity: --version writes zero bytes to stdout'
$version = Invoke-NodeCaptured @('src/mcp/main.js', '--version')
if ($version.ExitCode -ne 0) {
  throw "--version exited with code $($version.ExitCode)"
}
if ($version.StdoutBytes -ne 0) {
  throw "--version wrote $($version.StdoutBytes) byte(s) to stdout"
}
Write-Host "    stdout bytes: 0"

Step 'and the banner IS on stderr'
# Checked against the SAME capture, so this cannot pass for a server that
# printed nothing at all - which is the weaker guarantee being avoided.
if ($version.Stderr -notmatch 'GenXEvo') {
  throw 'the version banner is missing from stderr'
}

Invoke-Step 'production dependency tree' { npm ls --omit=dev }
Invoke-Step 'package contents' { npm pack --dry-run }

Write-Host 'ALL CHECKS PASSED' -ForegroundColor Green
