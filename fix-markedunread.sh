#!/bin/bash
# Script de correction pour l'erreur "markedUnread"
# À exécuter sur le serveur Linux

echo "========================================="
echo "  Correction erreur WhatsApp markedUnread"
echo "========================================="
echo ""

# 1. Arrêter le service
echo "1. Arrêt du service WhatsApp..."
pm2 stop whatsapp
sleep 2

# 2. Backup de l'ancienne session
echo ""
echo "2. Sauvegarde de la session..."
if [ -d ".wwebjs_auth" ]; then
    BACKUP=".wwebjs_auth_backup_$(date +%Y%m%d_%H%M%S)"
    mv .wwebjs_auth "$BACKUP"
    echo "   ✓ Session sauvegardée: $BACKUP"
else
    echo "   ℹ Aucune session à sauvegarder"
fi

# 3. Supprimer le cache
echo ""
echo "3. Nettoyage du cache..."
if [ -d ".wwebjs_cache" ]; then
    rm -rf .wwebjs_cache
    echo "   ✓ Cache supprimé"
else
    echo "   ℹ Aucun cache"
fi

# 4. Redémarrer avec la nouvelle config
echo ""
echo "4. Redémarrage avec la nouvelle configuration..."
pm2 restart whatsapp --update-env
sleep 3

echo ""
echo "========================================="
echo "  ✓ Correction appliquée"
echo "========================================="
echo ""
echo "IMPORTANT: Vous devez maintenant:"
echo "  1. Scanner le nouveau QR code"
echo "  2. Attendre 'Client prêt ✅'"
echo ""
echo "Pour voir le QR code et les logs:"
echo "  pm2 logs whatsapp"
echo ""
echo "Pour vérifier l'état:"
echo "  curl http://localhost:3400/status"
echo ""
