# Test the appointment reminder cron endpoint locally.
# Requires dev server running (npm run dev) and .env.local configured.

$envFile = Join-Path (Join-Path $PSScriptRoot "..") ".env.local"
if (-not (Test-Path $envFile)) {
    Write-Host "Missing .env.local" -ForegroundColor Red
    exit 1
}

$cronSecret = $null
$serviceRole = $null
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^CRON_SECRET=(.+)$') { $cronSecret = $matches[1].Trim() }
    if ($_ -match '^SUPABASE_SERVICE_ROLE_KEY=(.+)$') { $serviceRole = $matches[1].Trim() }
}

if (-not $cronSecret) {
    Write-Host "CRON_SECRET not set in .env.local" -ForegroundColor Red
    exit 1
}

if (-not $serviceRole) {
    Write-Host "SUPABASE_SERVICE_ROLE_KEY is empty." -ForegroundColor Yellow
    Write-Host "Add it from Supabase → Project Settings → API → service_role (Reveal), then run this script again."
    exit 1
}

$url = "http://localhost:3000/api/cron/appointment-reminders"
Write-Host "Calling $url ..." -ForegroundColor Cyan

try {
    $response = Invoke-RestMethod -Uri $url -Method GET -Headers @{
        Authorization = "Bearer $cronSecret"
    }
    $response | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Request failed:" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host $reader.ReadToEnd()
    } else {
        Write-Host $_.Exception.Message
    }
    exit 1
}