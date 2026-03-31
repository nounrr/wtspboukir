/**
 * Script de test pour vérifier le rate limiting
 * Envoie 5 messages et affiche le timing
 */

const { RateLimitedQueue } = require('./lib/sendQueue');

// Configuration : 2 messages par minute
const queue = new RateLimitedQueue({
  name: 'test-queue',
  minIntervalMs: 30000,      // 30 secondes minimum entre chaque message
  maxPerWindow: 120,          // 120 messages maximum
  windowMs: 3600000,          // par fenêtre de 60 minutes
  jitterMs: 15000,            // + 0-15 secondes aléatoires
  logger: console,
});

async function testRateLimit() {
  console.log('=== Test du Rate Limiting ===');
  console.log('Configuration:');
  console.log('- Minimum 30s entre chaque message');
  console.log('- Jitter aléatoire de 0-15s');
  console.log('- Résultat attendu: ~30-45s entre chaque message\n');

  const startTime = Date.now();
  let lastTime = startTime;

  for (let i = 1; i <= 5; i++) {
    await queue.enqueue(async () => {
      const now = Date.now();
      const timeSinceStart = ((now - startTime) / 1000).toFixed(2);
      const timeSinceLast = ((now - lastTime) / 1000).toFixed(2);
      
      console.log(`[${timeSinceStart}s] Message ${i}/5 envoyé`);
      console.log(`  → Délai depuis le dernier: ${timeSinceLast}s`);
      console.log(`  → Stats: ${JSON.stringify(queue.stats())}\n`);
      
      lastTime = now;
      return `Message ${i}`;
    });
  }

  console.log('=== Test terminé ===');
  console.log(`Temps total: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
}

testRateLimit().catch(console.error);
