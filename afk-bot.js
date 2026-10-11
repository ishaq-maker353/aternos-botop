/**
 * Standalone 24/7 Minecraft AFK Bot
 * Server: alamincraft.aternos.me:26832
 * 
 * Usage:
 *   1. Run: npm install mineflayer minecraft-protocol
 *   2. Start: node afk-bot.js
 *   3. Run 24/7 with PM2 (optional):
 *      npm install -g pm2
 *      pm2 start afk-bot.js --name "mc-afk-bot"
 *      pm2 save
 */

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
