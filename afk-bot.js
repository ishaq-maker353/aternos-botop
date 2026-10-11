/**
 * Standalone 24/7 Minecraft AFK Bot (with Railway Web Health Check)
 * Server: alamincraft.aternos.me:26832
 */

import http from 'http';
import mineflayer from 'mineflayer';
import mcProtocol from 'minecraft-protocol';

const CONFIG = {
  host: 'alamincraft.aternos.me',
  port: 26832,
  username: 'AFK_Bot_Pro',
  auth: 'offline', // 'offline' for cracked Aternos
  reconnectDelayMs: 10000,
  autoEat: true,
};

let bot = null;
let reconnectTimer = null;
let antiAfkInterval = null;

console.log('--------------------------------------------------');
console.log('🤖 Minecraft 24/7 AFK Bot Starting');
console.log(`🌐 Target: ${CONFIG.host}:${CONFIG.port}`);
console.log(`👤 Username: ${CONFIG.username}`);
console.log('--------------------------------------------------');

async function isServerOnline() {
  const ping = mcProtocol.ping || mcProtocol.default?.ping;
  if (!ping) return true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    ping({ host: CONFIG.host, port: CONFIG.port, closeTimeout: 4500 }, (err, res) => {
      clearTimeout(timeout);
      if (err) return resolve(false);
      const protocol = res?.version?.protocol;
      const desc = typeof res?.description === 'string' ? res.description : (res?.description?.text || '');
      if (protocol === -1 || desc.toLowerCase().includes('offline')) {
        return resolve(false);
      }
      resolve(true);
    });
  });
}

function startAntiAfk() {
  if (antiAfkInterval) clearInterval(antiAfkInterval);

  let tick = 0;
  antiAfkInterval = setInterval(() => {
    if (!bot || !bot.entity) return;
    tick++;

    try {
      // Periodic Arm Swing
      if (tick % 2 === 0) {
        bot.swingArm('right');
      }

      // Smooth Head Rotation
      if (tick % 3 === 0) {
        const yaw = (Math.random() - 0.5) * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.8;
        bot.look(yaw, pitch, true).catch(() => {});
      }

      // Periodic Jump
      if (tick % 7 === 0) {
        bot.setControlState('jump', true);
        setTimeout(() => bot && bot.setControlState('jump', false), 350);
      }

      // Micro-step patrol to bypass idle kick plugins
      if (tick % 6 === 0) {
        bot.setControlState('forward', true);
        setTimeout(() => {
          if (!bot) return;
          bot.setControlState('forward', false);
          bot.setControlState('back', true);
          setTimeout(() => bot && bot.setControlState('back', false), 250);
        }, 250);
      }

      // Auto-eat if food drops low
      if (CONFIG.autoEat && bot.food <= 14 && bot.inventory) {
        const food = bot.inventory.items().find(i => 
          ['bread', 'beef', 'steak', 'porkchop', 'carrot', 'apple', 'baked_potato'].some(k => i.name.includes(k))
        );
        if (food) {
          bot.equip(food, 'hand')
            .then(() => bot.consume())
            .catch(() => {});
        }
      }
    } catch {}
  }, 2000);
}

async function connectBot() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (antiAfkInterval) clearInterval(antiAfkInterval);

  console.log(`🔍 Checking if server is started on Aternos...`);
  const online = await isServerOnline();
  if (!online) {
    console.log(`⚠️  Server is currently in Standby/Offline mode.`);
    console.log(`👉 Please start it at https://aternos.org/servers/`);
    console.log(`⏳ Retrying in ${CONFIG.reconnectDelayMs / 1000} seconds...`);
    reconnectTimer = setTimeout(connectBot, CONFIG.reconnectDelayMs);
    return;
  }

  console.log(`🚀 Connecting bot to ${CONFIG.host}:${CONFIG.port}...`);

  try {
    bot = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      auth: CONFIG.auth,
      checkTimeoutInterval: 60000,
    });

    bot.on('login', () => {
      console.log(`✅ Logged in successfully!`);
    });

    bot.on('spawn', () => {
      console.log(`✨ Bot spawned in game at ${bot.entity.position}! Anti-AFK engine active.`);
      startAntiAfk();
    });

    bot.on('chat', (username, message) => {
      console.log(`💬 <${username}> ${message}`);
    });

    bot.on('kicked', (reason) => {
      console.log(`⚠️  Kicked: ${reason}`);
    });

    bot.on('error', (err) => {
      console.log(`❌ Error: ${err.message}`);
    });

    bot.on('end', () => {
      console.log(`🔌 Disconnected. Reconnecting in ${CONFIG.reconnectDelayMs / 1000}s...`);
      if (antiAfkInterval) clearInterval(antiAfkInterval);
      reconnectTimer = setTimeout(connectBot, CONFIG.reconnectDelayMs);
    });

  } catch (err) {
    console.log(`❌ Failed to create bot: ${err.message}`);
    reconnectTimer = setTimeout(connectBot, CONFIG.reconnectDelayMs);
  }
}

connectBot();

// Lightweight HTTP server for Railway web routing & health check
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const isSpawned = Boolean(bot && bot.entity);
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Minecraft AFK Bot - Railway Online</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0f19; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #131b2e; border: 1px solid #1e293b; padding: 2rem; border-radius: 12px; max-width: 480px; width: 100%; text-align: center; }
    .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 6px 14px; border-radius: 999px; font-weight: 600; font-size: 13px; margin-bottom: 1.25rem; }
    h1 { margin: 0 0 8px; font-size: 1.4rem; color: #f8fafc; font-weight: 700; }
    p { color: #94a3b8; font-size: 13px; line-height: 1.5; margin: 0 0 1rem; }
    .info { background: #0a0f1d; border: 1px solid #1e293b; padding: 14px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #38bdf8; text-align: left; margin: 1.25rem 0; line-height: 1.8; }
    .tip { font-size: 12px; color: #eab308; background: rgba(234, 179, 8, 0.1); border: 1px solid rgba(234, 179, 8, 0.2); padding: 10px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● 24/7 AFK BOT ACTIVE</div>
    <h1>Minecraft Bot is Running!</h1>
    <p>Railway container is healthy and actively maintaining the Minecraft AFK bot.</p>
    <div class="info">
      <div><strong>Server:</strong> ${CONFIG.host}:${CONFIG.port}</div>
      <div><strong>Username:</strong> ${CONFIG.username}</div>
      <div><strong>Bot State:</strong> ${isSpawned ? '🟢 In Game (Anti-AFK active)' : '🟡 Waiting for Aternos'}</div>
    </div>
    <div class="tip">
      👉 <strong>Important:</strong> Start your server on <a href="https://aternos.org/servers/" target="_blank" style="color: #fde047; font-weight: bold;">aternos.org</a> if it is currently offline!
    </div>
  </div>
</body>
</html>`;
  res.end(html);
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🌐 HTTP Web Server listening on port ${PORT} (Railway health check ready)`);
});
