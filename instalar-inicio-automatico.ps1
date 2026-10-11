# Registra el vigilante como tarea programada: arranca solo al iniciar sesion
# y se queda corriendo en segundo plano, sin ventanas.
#
#   Instalar:    powershell -ExecutionPolicy Bypass -File instalar-inicio-automatico.ps1
#   Desinstalar: powershell -ExecutionPolicy Bypass -File instalar-inicio-automatico.ps1 -Quitar

param([switch]$Quitar)

$nombre = "WallapopWatcher"
$carpeta = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $carpeta "iniciar-oculto.vbs"

if ($Quitar) {
    try {
        Unregister-ScheduledTask -TaskName $nombre -Confirm:$false -ErrorAction Stop
        Write-Host "Tarea '$nombre' eliminada. El vigilante ya no arrancara solo."
    } catch {
        Write-Host "No habia ninguna tarea '$nombre' registrada."
    }
    return
}

if (-not (Test-Path $vbs)) { throw "No encuentro $vbs" }

$accion = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $carpeta
$disparador = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparador -Settings $ajustes `
    -Description "Avisa por WhatsApp cuando aparece un chollo en Wallapop" -Force | Out-Null

Write-Host "Listo. '$nombre' arrancara solo cada vez que inicies sesion en Windows."
Write-Host "Para arrancarlo ya mismo sin reiniciar:  Start-ScheduledTask -TaskName $nombre"
