# Configuration du Rate Limiting WhatsApp

## Configuration actuelle

Le service `whtsp-service` est maintenant configuré pour envoyer **2 messages par minute** avec un délai aléatoire entre chaque message.

### Paramètres dans `.env`

```env
# Fenêtre de 60 minutes (1 heure)
WA_RATE_WINDOW_MS=3600000

# Maximum 120 messages par heure (= 2 messages/minute)
WA_RATE_MAX=120

# Intervalle minimum de 30 secondes entre chaque message
WA_MIN_INTERVAL_MS=30000

# Délai aléatoire de 0 à 15 secondes ajouté
WA_JITTER_MS=15000
```

## Comment ça fonctionne ?

### 1. Intervalle de base (30 secondes)
Le système attend **minimum 30 secondes** entre chaque message.

### 2. Délai aléatoire (0-15 secondes)
Un délai aléatoire de **0 à 15 secondes** est ajouté pour rendre l'envoi plus naturel.

### 3. Résultat final
- **Délai minimum** : 30 secondes
- **Délai maximum** : 45 secondes (30s + 15s)
- **Moyenne** : ~37.5 secondes entre chaque message
- **Taux d'envoi** : ~2 messages par minute (peut légèrement varier selon le jitter)

## Exemple de timing

```
Minute 1:
├─ 00:00 → Message 1
├─ 00:35 → Message 2 (délai: 35s = 30s + 5s random)
│
Minute 2:
├─ 01:08 → Message 3 (délai: 33s = 30s + 3s random)
├─ 01:50 → Message 4 (délai: 42s = 30s + 12s random)
│
Minute 3:
└─ 02:23 → Message 5 (délai: 33s = 30s + 3s random)
```

## Test de la configuration

Pour tester le système sans envoyer de vrais messages WhatsApp:

```powershell
cd c:\xampp\htdocs\RH\whtsp-service
node test-rate-limit.js
```

Ce script simule l'envoi de 5 messages et affiche le timing réel entre chaque message.

## Redémarrage du service

Après modification du `.env`, redémarrez le service:

```powershell
# Si vous utilisez PM2
pm2 restart whtsp-service

# Ou redémarrez manuellement
# Ctrl+C puis npm start
```

## Surveillance en temps réel

Vous pouvez vérifier l'état de la queue d'envoi:

```
GET http://localhost:3400/status
```

Cela retourne les statistiques incluant:
- `sendQueue.queued`: Nombre de messages en attente
- `sendQueue.processing`: Si la queue traite actuellement
- `sendQueue.sentInWindow`: Nombre de messages envoyés dans la fenêtre actuelle
- `sendQueue.minIntervalMs`: Intervalle minimum configuré
- `sendQueue.jitterMs`: Jitter aléatoire configuré

## Ajustement de la configuration

### Pour envoyer plus de messages par minute (ex: 3 messages/min)

```env
WA_RATE_MAX=180              # 3 messages/min × 60 min
WA_MIN_INTERVAL_MS=20000     # 60s ÷ 3 messages = 20s
WA_JITTER_MS=10000           # 0-10s aléatoire
```

### Pour envoyer moins de messages par minute (ex: 1 message/min)

```env
WA_RATE_MAX=60               # 1 message/min × 60 min
WA_MIN_INTERVAL_MS=60000     # 60s
WA_JITTER_MS=20000           # 0-20s aléatoire
```

## Pourquoi ces limites ?

WhatsApp peut bloquer ou bannir les comptes qui envoient trop de messages trop rapidement. La configuration actuelle (2 messages/minute avec délai aléatoire) offre un bon équilibre entre:

1. ✅ **Efficacité** : Assez rapide pour envoyer des notifications
2. ✅ **Sécurité** : Assez lent pour éviter les bans WhatsApp
3. ✅ **Naturel** : Le délai aléatoire imite un comportement humain

## Notes importantes

- Les messages sont mis en queue automatiquement
- Si vous envoyez 10 messages d'un coup, ils seront espacés selon la configuration
- La queue est persistante pendant la durée de vie du processus
- Redémarrer le service vide la queue (messages non envoyés seront perdus)
