param([switch]$ReuseBuild)
# Formal release: NSIS installer and directory portable ZIP.
& "$PSScriptRoot/package-app.ps1" -Profile release -Installer -ReuseBuild:$ReuseBuild
