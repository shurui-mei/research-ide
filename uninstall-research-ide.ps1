$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'apps\desktop\resources\uninstall\uninstall-research-ide.ps1') @args
exit $LASTEXITCODE
