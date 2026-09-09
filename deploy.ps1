# AeroMesh — Local production deploy script
# Copies built frontend into backend static dir, then runs the server

Write-Host "AeroMesh Deploy Script" -ForegroundColor Cyan
Write-Host "=====================" -ForegroundColor Cyan

# Step 1: Build frontend
Write-Host "`n[1/3] Building frontend..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\aeromesh-frontend\aeromesh-frontend"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Frontend build failed!" -ForegroundColor Red; exit 1 }

# Step 2: Copy dist to backend static
Write-Host "`n[2/3] Copying to backend static..." -ForegroundColor Yellow
$staticDir = "$PSScriptRoot\aeromesh-backend\aeromesh-backend\static"
if (Test-Path $staticDir) { Remove-Item -Recurse -Force $staticDir }
Copy-Item -Recurse "dist" $staticDir
Write-Host "  Copied to $staticDir"

# Step 3: Start production server
Write-Host "`n[3/3] Starting production server..." -ForegroundColor Yellow
Set-Location "$PSScriptRoot\aeromesh-backend\aeromesh-backend"
Write-Host "  Server running at http://localhost:8000" -ForegroundColor Green
uvicorn main:app --host 0.0.0.0 --port 8000
