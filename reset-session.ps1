# Script pour réinitialiser la session WhatsApp
# Utiliser quand vous avez des erreurs de connexion

Write-Host "=== Reset WhatsApp Session ===" -ForegroundColor Cyan
Write-Host ""

# Arrêter le service PM2 si actif
Write-Host "1. Arrêt du service..." -ForegroundColor Yellow
try {
    # Le nom PM2 peut varier selon la config (ecosystem.config.js utilise souvent "whatsapp")
    pm2 stop whatsapp 2>$null
    pm2 stop whtsp-service 2>$null
    Write-Host "   Stop demandé (whatsapp / whtsp-service)" -ForegroundColor Green
} catch {
    Write-Host "   Service non actif ou PM2 non installé" -ForegroundColor Gray
}

# Sauvegarder l'ancienne session (backup)
Write-Host ""
Write-Host "2. Sauvegarde de l'ancienne session..." -ForegroundColor Yellow
$backupDir = ".wwebjs_auth_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
if (Test-Path ".wwebjs_auth") {
    Copy-Item -Path ".wwebjs_auth" -Destination $backupDir -Recurse -Force
    Write-Host "   Session sauvegardée dans: $backupDir" -ForegroundColor Green
} else {
    Write-Host "   Aucune session à sauvegarder" -ForegroundColor Gray
}

# Supprimer la session actuelle
Write-Host ""
Write-Host "3. Suppression de la session actuelle..." -ForegroundColor Yellow
if (Test-Path ".wwebjs_auth") {
    Remove-Item -Path ".wwebjs_auth" -Recurse -Force
    Write-Host "   Session supprimée" -ForegroundColor Green
} else {
    Write-Host "   Aucune session à supprimer" -ForegroundColor Gray
}

# Supprimer le cache
Write-Host ""
Write-Host "4. Nettoyage du cache..." -ForegroundColor Yellow
if (Test-Path ".wwebjs_cache") {
    Remove-Item -Path ".wwebjs_cache" -Recurse -Force
    Write-Host "   Cache supprimé" -ForegroundColor Green
} else {
    Write-Host "   Aucun cache à supprimer" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== Reset terminé ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Prochaines étapes:" -ForegroundColor Yellow
Write-Host "  1. Démarrer le service: pm2 restart whtsp-service" -ForegroundColor White
Write-Host "  2. Scanner le QR code qui s'affiche" -ForegroundColor White
Write-Host "  3. Vérifier le statut: pm2 logs whtsp-service" -ForegroundColor White
Write-Host ""
