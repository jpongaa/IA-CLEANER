# Coloca o Node 22 (instalado via nvm) na frente do PATH apenas para esta sessão.
# Uso:  . .\scripts\node22.ps1 ; npm run dev
$node22 = Join-Path $env:LOCALAPPDATA 'nvm\v22.17.0'
if (-not (Test-Path (Join-Path $node22 'node.exe'))) {
  Write-Error "Node 22 não encontrado em $node22. Instale com: nvm install 22"
  return
}
if (-not ($env:Path -like "$node22;*")) { $env:Path = "$node22;" + $env:Path }
Write-Host "Usando Node $(node -v)"
