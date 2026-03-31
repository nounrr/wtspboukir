const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth(), // garde ta session pour éviter de rescanner à chaque fois
});

client.on('qr', (qr) => {
  console.log('Scanne ce QR avec WhatsApp :');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Client prêt ✅');

  // 1) Numéro au format international sans "+" ni espaces
  const phoneNumber = '212659595284'; // remplace par le numéro

  // 2) WhatsApp utilise le suffixe @c.us
  const chatId = phoneNumber + '@c.us';

  // 3) Envoyer le message
  client.sendMessage(chatId, 'Salam, ce message a été envoyé depuis Node.js 😄')
    .then(() => {
      console.log('Message envoyé ✅');
    })
    .catch((err) => {
      console.error('Erreur envoi message ❌', err);
    });
});

client.on('auth_failure', (msg) => {
  console.error('Erreur d’authentification :', msg);
});

client.on('disconnected', (reason) => {
  console.log('Déconnecté :', reason);
});

client.initialize();
