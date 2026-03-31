#!/bin/bash
# Script pour réinitialiser la session WhatsApp sur Linux
# Utiliser quand vous avez des erreurs de connexion

echo -e "\033[1;36m=== Reset WhatsApp Session ===\033[0m"
echo ""

# Arrêter le service PM2 si actif
echo -e "\033[1;33m1. Arrêt du service...\033[0m"
pm2 stop whatsapp 2>/dev/null
if [ $? -eq 0 ]; then
    echo -e "\033[1;32m   Service arrêté\033[0m"
else
    echo -e "\033[0;37m   Service non actif ou PM2 non installé\033[0m"
fi

# Sauvegarder l'ancienne session (backup)
echo ""
echo -e "\033[1;33m2. Sauvegarde de l'ancienne session...\033[0m"
BACKUP_DIR=".wwebjs_auth_backup_$(date +%Y%m%d_%H%M%S)"
if [ -d ".wwebjs_auth" ]; then
    cp -r .wwebjs_auth "$BACKUP_DIR"
    echo -e "\033[1;32m   Session sauvegardée dans: $BACKUP_DIR\033[0m"
else
    echo -e "\033[0;37m   Aucune session à sauvegarder\033[0m"
fi

# Supprimer la session actuelle
echo ""
echo -e "\033[1;33m3. Suppression de la session actuelle...\033[0m"
if [ -d ".wwebjs_auth" ]; then
    rm -rf .wwebjs_auth
    echo -e "\033[1;32m   Session supprimée\033[0m"
else
    echo -e "\033[0;37m   Aucune session à supprimer\033[0m"
fi

# Supprimer le cache
echo ""
echo -e "\033[1;33m4. Nettoyage du cache...\033[0m"
if [ -d ".wwebjs_cache" ]; then
    rm -rf .wwebjs_cache
    echo -e "\033[1;32m   Cache supprimé\033[0m"
else
    echo -e "\033[0;37m   Aucun cache à supprimer\033[0m"
fi

echo ""
echo -e "\033[1;36m=== Reset terminé ===\033[0m"
echo ""
echo -e "\033[1;33mProchaines étapes:\033[0m"
echo -e "\033[1;37m  1. Démarrer le service: pm2 restart whatsapp\033[0m"
echo -e "\033[1;37m  2. Scanner le QR code qui s'affiche\033[0m"
echo -e "\033[1;37m  3. Vérifier le statut: pm2 logs whatsapp\033[0m"
echo ""
