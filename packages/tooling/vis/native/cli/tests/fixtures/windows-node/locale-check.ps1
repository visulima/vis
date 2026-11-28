# Shows, on Windows, that the native `vis run` follows the collation of the user locale as the Node CLI does: Node's
# `localeCompare` reads the user locale (`GetUserDefaultLocaleName`) and ignores LANG and LC_*, and the binary answers a
# run in which every task hits only under a locale without collation tailoring.
#
#     powershell -File locale-check.ps1 <path to the Node CLI's dist/bin.js> <path to vis.exe> <a scratch directory>
#
# It changes the user's culture with Set-Culture (new processes read it) and puts the original back in a `finally`, so
# run it in a throw-away session, not on a machine whose locale matters while it runs. Exits 1 when a check fails.
param([string]$Cli, [string]$Binary, [string]$Scratch)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$failed = $false
$original = (Get-ItemProperty "HKCU:\Control Panel\International").LocaleName

function Check([string]$label, [bool]$ok, [string]$detail) {
    if (-not $ok) { $script:failed = $true }
    Write-Output ("{0} {1} :: {2}" -f $(if ($ok) { "PASS" } else { "FAIL" }), $label, $detail)
}

function Step([string]$culture) {
    Set-Culture $culture
    $line = node (Join-Path $here "locale-check.mjs") $Cli $Binary (Join-Path $Scratch $culture)
    $step = $line | ConvertFrom-Json
    # The orders below are only meaningful when the Node run they come from was the all-hit run.
    # `Out-Host`: this function's output is its return value, which a check line written to the pipeline would join.
    Check "${culture}: the second Node run read all four tasks from the cache" ([bool]$step.node.cached) ("cached = " + $step.node.cached) | Out-Host
    return $step
}

try {
    $english = Step "en-US"
    Check "en-US: Node starts c, ch, d, h" (($english.node.starts -join ",") -eq "c:build,ch:build,d:build,h:build") ($english.node.starts -join ",")
    Check "en-US: the binary lists the hook stages as Node does" (($english.hooks.node -join ",") -eq "commit-msg,post-checkout,post-commit,pre-commit" -and $english.hooks.binary.same) ($english.hooks.node -join ",")
    Check "en-US: the binary answers with Node's order" (($english.binary.status -eq 0) -and (($english.binary.starts -join ",") -eq ($english.node.starts -join ","))) ("exit " + $english.binary.status)

    foreach ($culture in @("cs-CZ", "sk-SK")) {
        $tailored = Step $culture
        Check "${culture}: Node sorts ch after h" (($tailored.node.starts -join ",") -eq "c:build,d:build,h:build,ch:build") ($tailored.node.starts -join ",")
        Check "${culture}: the binary hands the run back" (($tailored.binary.status -eq 75) -and ($tailored.binary.stdoutBytes -eq 0)) ("exit " + $tailored.binary.status)
        Check "${culture}: Node lists post-commit before post-checkout and the binary prints Node's list" (($tailored.hooks.node -join ",") -eq "commit-msg,post-commit,post-checkout,pre-commit" -and $tailored.hooks.binary.status -eq 0 -and $tailored.hooks.binary.same) ($tailored.hooks.node -join ",")
    }

    foreach ($culture in @("da-DK", "hu-HU", "es-ES_tradnl", "sv-SE", "de-DE")) {
        $other = Step $culture
        Check "${culture}: the binary hands the run back" (($other.binary.status -eq 75) -and ($other.binary.stdoutBytes -eq 0)) ("exit " + $other.binary.status)
    }

    $british = Step "en-GB"
    Check "en-GB: the binary answers" ($british.binary.status -eq 0) ("exit " + $british.binary.status)

    # Locale variables are not what Node reads on Windows, and not what the binary reads either.
    $env:LC_ALL = "cs_CZ"
    $variable = Step "en-US"
    Remove-Item Env:LC_ALL
    Check "en-US with LC_ALL=cs_CZ: Node ignores it and so does the binary" (($variable.node.starts -join ",") -eq "c:build,ch:build,d:build,h:build" -and $variable.binary.status -eq 0) ("exit " + $variable.binary.status)
} finally {
    Set-Culture $original
    Write-Output ("restored user locale = " + (Get-ItemProperty "HKCU:\Control Panel\International").LocaleName)
}

if ($failed) { exit 1 }
