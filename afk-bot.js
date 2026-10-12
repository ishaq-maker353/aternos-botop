/**
 * Standalone 24/7 Minecraft AFK Bot & Real Minecraft Web Dashboard
 * Optimized for Aternos (Anti-Detection Patrol & 1-Click Server Launcher)
 * Compatible with Railway, Render, VPS, or local Node.js.
 */

import http from 'http';
import mineflayer from 'mineflayer';
import mcProtocol from 'minecraft-protocol';

// Default Bot Configuration
const CONFIG = {
  host: 'alamincraft.aternos.me',
  port: 26832,
  username: 'AFK_Bot_Pro',
  auth: 'offline', // 'offline' for cracked Aternos
  version: 'auto',
  autoReconnect: true,
  reconnectDelayMs: 10000,
  autoEat: true,
  antiAfk: {
    enabled: true,
    jump: true,
    rotate: true,
    swing: true,
    sneak: false,
    walk: true,
    aternosAntiDetect: true, // Physical block-crossing patrol so Aternos doesn't detect bot idling
    cycleHotbar: true,       // Cycle held item slot every 16s to send packets and reset server idle shutdown
    blockPatrol: true,
    chatIntervalSeconds: 0,
    chatMessage: '',
  },
};

let bot = null;
let reconnectTimer = null;
let antiAfkInterval = null;
let periodicChatInterval = null;
let botStatus = 'offline'; // 'offline' | 'connecting' | 'online' | 'reconnecting' | 'error' | 'kicked'
let lastError = null;
let lastKickReason = null;
let connectedAt = null;
let reconnectCountdown = 0;
let reconnectCountdownInterval = null;

// 1-Click Server Watcher / Radar
let serverWatcherActive = false;
let serverWatcherTimer = null;
let serverWatcherStage = 'idle'; // 'idle' | 'checking' | 'starting' | 'online'
let serverWatcherMessage = '';

const chatMessages = [];
const activityLogs = [];
const sseClients = [];

function addLog(level, message) {
  const time = new Date().toLocaleTimeString();
  const entry = { id: Date.now() + Math.random(), level, message, time };
  activityLogs.push(entry);
  if (activityLogs.length > 200) activityLogs.shift();
  console.log(`[${time}] [${level.toUpperCase()}] ${message}`);
  broadcastSSE('log', entry);
}

function addChat(sender, text, isSystem = false) {
  const time = new Date().toLocaleTimeString();
  const msg = { id: Date.now() + Math.random(), sender, text, isSystem, time };
  chatMessages.push(msg);
  if (chatMessages.length > 200) chatMessages.shift();
  broadcastSSE('chat', msg);
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

function getBotSnapshot() {
  const isOnline = botStatus === 'online' && Boolean(bot && bot.entity);
  const health = isOnline && typeof bot.health === 'number' ? bot.health : 20;
  const food = isOnline && typeof bot.food === 'number' ? bot.food : 20;
  const foodSaturation = isOnline && typeof bot.foodSaturation === 'number' ? bot.foodSaturation : 5;
  const xp = isOnline && bot.experience ? {
    level: bot.experience.level || 0,
    progress: Math.round((bot.experience.progress || 0) * 100),
    points: bot.experience.points || 0,
  } : { level: 0, progress: 0, points: 0 };

  const pos = isOnline && bot.entity?.position ? {
    x: Math.round(bot.entity.position.x * 10) / 10,
    y: Math.round(bot.entity.position.y * 10) / 10,
    z: Math.round(bot.entity.position.z * 10) / 10,
    yaw: Math.round((bot.entity.yaw || 0) * (180 / Math.PI)),
    pitch: Math.round((bot.entity.pitch || 0) * (180 / Math.PI)),
    dimension: bot.game?.dimension || 'Overworld',
  } : { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dimension: 'Overworld' };

  const players = isOnline && bot.players ? Object.keys(bot.players) : [];
  const inventory = isOnline && bot.inventory ? bot.inventory.items().map(i => ({
    name: i.name,
    displayName: i.displayName || i.name,
    count: i.count,
    slot: i.slot,
  })) : [];

  const uptimeSeconds = isOnline && connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : 0;
  const ping = isOnline && bot.player?.ping ? bot.player.ping : 0;

  return {
    state: botStatus,
    config: CONFIG,
    uptime: uptimeSeconds,
    reconnectCountdown,
    health,
    food,
    foodSaturation,
    xp,
    position: pos,
    players,
    inventory,
    ping,
    errorMessage: lastError,
    kickReason: lastKickReason,
    watcher: {
      active: serverWatcherActive,
      stage: serverWatcherStage,
      message: serverWatcherMessage,
    },
  };
}

// Check if Minecraft server is online or in Aternos standby
async function isServerOnline(host = CONFIG.host, port = CONFIG.port) {
  const ping = mcProtocol.ping || mcProtocol.default?.ping;
  if (!ping) return { online: true };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ online: false, error: 'Ping timed out (Server may be offline)' }), 4500);
    ping({ host: host.trim(), port: Number(port), closeTimeout: 4000 }, (err, res) => {
      clearTimeout(timeout);
      if (err) {
        const msg = err.message || '';
        const isOffline = msg.includes('ECONNREFUSED') || msg.includes('timed out') || msg.includes('ENOTFOUND');
        return resolve({
          online: false,
          error: isOffline ? 'Server is offline or unreachable' : msg,
        });
      }
      const protocol = res?.version?.protocol;
      const desc = typeof res?.description === 'string' ? res.description : (res?.description?.text || '');
      if (protocol === -1 || desc.toLowerCase().includes('offline')) {
        return resolve({
          online: false,
          isStandby: true,
          error: 'Aternos server is in standby / offline (protocol -1). Press Start on aternos.org.',
        });
      }
      resolve({
        online: true,
        version: res?.version?.name,
        latency: res?.latency,
        players: res?.players,
      });
    });
  });
}

// 1-Click Server Watcher Radar functions
function broadcastWatcherStatus() {
  broadcastSSE('watcher', {
    active: serverWatcherActive,
    stage: serverWatcherStage,
    message: serverWatcherMessage,
    host: CONFIG.host,
    port: CONFIG.port,
  });
  broadcastSSE('status', getBotSnapshot());
}

function stopServerWatcher() {
  serverWatcherActive = false;
  if (serverWatcherTimer) {
    clearInterval(serverWatcherTimer);
    serverWatcherTimer = null;
  }
  serverWatcherStage = 'idle';
  serverWatcherMessage = '';
  broadcastWatcherStatus();
}

async function runServerWatcherCheck() {
  if (!serverWatcherActive) return;

  try {
    const res = await isServerOnline(CONFIG.host, CONFIG.port);
    if (res.online) {
      serverWatcherStage = 'online';
      serverWatcherMessage = `Server ${CONFIG.host}:${CONFIG.port} is ONLINE! Connecting bot immediately...`;
      addLog('success', `[1-Click Radar] Server is ONLINE! Connecting bot now...`);
      broadcastWatcherStatus();
      stopServerWatcher();
      connectBot();
      return;
    }

    if (res.isStandby) {
      serverWatcherStage = 'starting';
      serverWatcherMessage = 'Aternos server is starting up or in queue. Waiting for chunks to load...';
    } else {
      serverWatcherStage = 'checking';
      serverWatcherMessage = `Polling ${CONFIG.host}:${CONFIG.port} every 3s... (Waiting for server to turn Online)`;
    }
    broadcastWatcherStatus();
  } catch (err) {
    serverWatcherStage = 'checking';
    serverWatcherMessage = `Checking server: ${err?.message || 'waiting...'}`;
    broadcastWatcherStatus();
  }
}

function startServerWatcher(host, port) {
  if (host) CONFIG.host = host.trim();
  if (port) CONFIG.port = Number(port);

  stopServerWatcher();
  serverWatcherActive = true;
  serverWatcherStage = 'checking';
  serverWatcherMessage = `Radar Active: Checking ${CONFIG.host}:${CONFIG.port} every 3s...`;
  addLog('info', `[1-Click Watcher] Radar started for ${CONFIG.host}:${CONFIG.port}. Bot will auto-join as soon as server boots.`);
  broadcastWatcherStatus();

  runServerWatcherCheck();
  serverWatcherTimer = setInterval(runServerWatcherCheck, 3000);
}

// Anti-AFK engine with Aternos Human Simulation AI
function startAntiAfk() {
  if (antiAfkInterval) clearInterval(antiAfkInterval);

  let tick = 0;
  let patrolStep = 0;

  antiAfkInterval = setInterval(() => {
    if (!bot || !bot.entity || botStatus !== 'online') return;
    if (!CONFIG.antiAfk.enabled) return;
    tick++;

    try {
      // 1. Arm swing with variable rhythm
      if (CONFIG.antiAfk.swing && tick % 2 === 0) {
        bot.swingArm('right');
      }

      // 2. Realistic human head look around
      if (CONFIG.antiAfk.rotate && tick % 3 === 0) {
        const yaw = (Math.random() - 0.5) * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.7; // natural tilt
        bot.look(yaw, pitch, true).catch(() => {});
      }

      // 3. Periodic jump
      if (CONFIG.antiAfk.jump && tick % 7 === 0) {
        bot.setControlState('jump', true);
        setTimeout(() => bot && bot.setControlState('jump', false), 350);
      }

      // 4. Sneak / crouch
      if (CONFIG.antiAfk.sneak && tick % 5 === 0) {
        bot.setControlState('sneak', true);
        setTimeout(() => bot && bot.setControlState('sneak', false), 600);
      }

      // 5. ATERNOS ANTI-DETECTION: Physical block-crossing patrol!
      // Servers detect bots if they remain on the exact same block coordinate.
      // We patrol in a micro square pattern (Forward -> Right -> Back -> Left) crossing block borders.
      if (CONFIG.antiAfk.walk) {
        if (CONFIG.antiAfk.aternosAntiDetect) {
          if (tick % 4 === 0) {
            patrolStep = (patrolStep + 1) % 4;
            const dir = patrolStep === 0 ? 'forward' : patrolStep === 1 ? 'right' : patrolStep === 2 ? 'back' : 'left';
            bot.setControlState(dir, true);
            setTimeout(() => {
              if (bot) bot.setControlState(dir, false);
            }, 600);
          }
        } else {
          // Twitch
          if (tick % 6 === 0) {
            bot.setControlState('forward', true);
            setTimeout(() => {
              if (!bot) return;
              bot.setControlState('forward', false);
              bot.setControlState('back', true);
              setTimeout(() => bot && bot.setControlState('back', false), 250);
            }, 250);
          }
        }
      }

      // 6. HOTBAR CYCLING: Cycle held item slot every 16 seconds
      // Sends PacketPlayInHeldItemSlot packets to the server, resetting the Aternos idle shutdown timer!
      if (CONFIG.antiAfk.cycleHotbar !== false && tick % 8 === 0) {
        try {
          const currentSlot = bot.quickBarSlot || 0;
          const nextSlot = (currentSlot + 1) % 9;
          bot.setQuickBarSlot(nextSlot);
        } catch {}
      }

      // 7. Auto-eat check
      if (CONFIG.autoEat && bot.food <= 14 && bot.inventory) {
        attemptAutoEat();
      }
    } catch {}
  }, 2000);

  // Periodic Chat
  if (periodicChatInterval) clearInterval(periodicChatInterval);
  if (CONFIG.antiAfk.chatIntervalSeconds > 0 && CONFIG.antiAfk.chatMessage) {
    periodicChatInterval = setInterval(() => {
      if (bot && botStatus === 'online') {
        const msg = CONFIG.antiAfk.chatMessage.trim();
        if (msg) {
          bot.chat(msg);
          addChat(CONFIG.username, msg, false);
          addLog('info', `Sent periodic message: "${msg}"`);
        }
      }
    }, CONFIG.antiAfk.chatIntervalSeconds * 1000);
  }
}

function attemptAutoEat() {
  if (!bot || !bot.inventory) return;
  const foodKeywords = [
    'bread', 'cooked_beef', 'cooked_porkchop', 'steak', 'porkchop', 'golden_carrot',
    'apple', 'golden_apple', 'cooked_mutton', 'cooked_chicken', 'baked_potato',
    'carrot', 'sweet_berries', 'cookie', 'melon_slice'
  ];

  try {
    const foodItem = bot.inventory.items().find(item =>
      foodKeywords.some(keyword => item.name.includes(keyword))
    );

    if (foodItem) {
      bot.equip(foodItem, 'hand')
        .then(() => bot.consume())
        .then(() => {
          addLog('info', `Bot ate ${foodItem.displayName || foodItem.name} to restore hunger.`);
        })
        .catch(() => {});
    }
  } catch {}
}

function clearTimers() {
  if (antiAfkInterval) {
    clearInterval(antiAfkInterval);
    antiAfkInterval = null;
  }
  if (periodicChatInterval) {
    clearInterval(periodicChatInterval);
    periodicChatInterval = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (reconnectCountdownInterval) {
    clearInterval(reconnectCountdownInterval);
    reconnectCountdownInterval = null;
  }
}

function scheduleReconnect(customDelaySeconds) {
  if (!CONFIG.autoReconnect) {
    botStatus = 'offline';
    broadcastSSE('status', getBotSnapshot());
    return;
  }

  clearTimers();
  botStatus = 'reconnecting';
  reconnectCountdown = customDelaySeconds || Math.round(CONFIG.reconnectDelayMs / 1000) || 10;
  broadcastSSE('status', getBotSnapshot());
  addLog('warn', `Reconnecting in ${reconnectCountdown}s...`);

  reconnectCountdownInterval = setInterval(() => {
    reconnectCountdown--;
    broadcastSSE('status', getBotSnapshot());
    if (reconnectCountdown <= 0) {
      if (reconnectCountdownInterval) clearInterval(reconnectCountdownInterval);
      reconnectCountdownInterval = null;
      addLog('info', 'Executing auto-reconnect now...');
      connectBot();
    }
  }, 1000);
}

// Safely destroy socket and clean up bot instance
function cleanupBotSocket() {
  if (bot) {
    try {
      (bot as any)?._client?.socket?.destroy?.();
    } catch {}
    try {
      bot.removeAllListeners();
      bot.end();
    } catch {}
    bot = null;
  }
}

async function connectBot() {
  clearTimers();
  cleanupBotSocket();

  botStatus = 'connecting';
  lastError = null;
  lastKickReason = null;
  broadcastSSE('status', getBotSnapshot());
  addLog('info', `Checking server status at ${CONFIG.host}:${CONFIG.port}...`);

  const check = await isServerOnline();
  if (!check.online) {
    botStatus = 'error';
    lastError = check.error || 'Server is offline';
    addLog('warn', lastError);
    scheduleReconnect();
    return;
  }

  addLog('info', `Connecting bot to ${CONFIG.host}:${CONFIG.port} as "${CONFIG.username}"...`);

  try {
    const botOptions = {
      host: CONFIG.host.trim(),
      port: Number(CONFIG.port),
      username: CONFIG.username.trim(),
      auth: CONFIG.auth,
      checkTimeoutInterval: 60000,
    };

    if (CONFIG.version && CONFIG.version !== 'auto') {
      botOptions.version = CONFIG.version;
    } else if (check.version) {
      const match = check.version.match(/\b(1\.\d+(\.\d+)?)\b/);
      if (match) botOptions.version = match[1];
    }

    const newBot = mineflayer.createBot(botOptions);
    bot = newBot;

    newBot.on('login', () => {
      addLog('success', `Logged in successfully! Loading chunks...`);
    });

    newBot.on('spawn', () => {
      botStatus = 'online';
      connectedAt = Date.now();
      const pos = newBot.entity?.position;
      const posStr = pos ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : '';
      addLog('success', `Bot spawned at ${posStr}! Aternos Anti-Detection & Anti-AFK engine initialized.`);
      startAntiAfk();
      broadcastSSE('status', getBotSnapshot());
    });

    newBot.on('chat', (username, message) => {
      addChat(username, message, false);
    });

    newBot.on('messagestr', (message) => {
      if (message && !message.includes('<') && !message.includes(':')) {
        addChat('SERVER', message, true);
      }
    });

    newBot.on('health', () => {
      broadcastSSE('status', getBotSnapshot());
      if (newBot.health <= 0) {
        addLog('warn', 'Bot took fatal damage or died.');
      }
    });

    newBot.on('death', () => {
      addLog('warn', 'Bot died! Auto-respawning in 3 seconds...');
      setTimeout(() => {
        try {
          if (bot && botStatus === 'online') {
            bot.respawn();
            addLog('info', 'Bot respawned.');
          }
        } catch {}
      }, 3000);
    });

    newBot.on('playerJoined', (player) => {
      addLog('info', `Player joined: ${player.username}`);
      broadcastSSE('status', getBotSnapshot());
    });

    newBot.on('playerLeft', (player) => {
      addLog('info', `Player left: ${player.username}`);
      broadcastSSE('status', getBotSnapshot());
    });

    // DUPLICATE LOGIN RECOVERY
    newBot.on('kicked', (reason) => {
      botStatus = 'kicked';
      let reasonStr = 'Unknown reason';
      try {
        reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
      } catch {
        reasonStr = String(reason);
      }

      cleanupBotSocket();

      if (reasonStr.includes('duplicate_login')) {
        const randNum = Math.floor(100 + Math.random() * 900);
        const oldName = CONFIG.username;
        const newName = `${oldName.replace(/_\d+$/, '')}_${randNum}`;
        CONFIG.username = newName;
        lastKickReason = `Duplicate Login: Player "${oldName}" is still active or disconnecting on server. Auto-switched username to "${newName}".`;
        addLog('warn', lastKickReason);
        broadcastSSE('status', getBotSnapshot());
        // Wait 12 seconds for the server to finish closing the ghost session
        scheduleReconnect(12);
      } else {
        lastKickReason = `Kicked: ${reasonStr}`;
        lastError = lastKickReason;
        addLog('warn', lastKickReason);
        broadcastSSE('status', getBotSnapshot());
        scheduleReconnect();
      }
    });

    newBot.on('error', (err) => {
      const msg = err?.message || String(err);
      botStatus = 'error';
      lastError = msg;
      cleanupBotSocket();
      addLog('error', `Bot error: ${msg}`);
      broadcastSSE('status', getBotSnapshot());
    });

    newBot.on('end', (reason) => {
      addLog('warn', `Disconnected: ${reason || 'Connection lost'}`);
      const wasKicked = botStatus === 'kicked';
      if (!wasKicked && botStatus !== 'error') {
        botStatus = 'offline';
      }
      connectedAt = null;
      cleanupBotSocket();

      if (!wasKicked) {
        clearTimers();
        broadcastSSE('status', getBotSnapshot());
        scheduleReconnect();
      }
    });

  } catch (err) {
    botStatus = 'error';
    lastError = err.message;
    addLog('error', `Failed to initialize bot: ${err.message}`);
    broadcastSSE('status', getBotSnapshot());
    scheduleReconnect();
  }
}

// Process error traps so node never terminates on unhandled protocol errors
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason);
  if (msg.includes('protocol version') || msg.includes('minecraftVersion')) {
    addLog('warn', 'Server is in standby or offline (protocol -1). Waiting for server to boot...');
    return;
  }
  console.warn('Caught unhandled rejection:', msg);
});

process.on('uncaughtException', (err) => {
  const msg = String(err?.message || err);
  if (msg.includes('protocol version') || msg.includes('minecraftVersion')) {
    addLog('warn', 'Server is in standby or offline (protocol -1). Waiting for server to boot...');
    return;
  }
  console.warn('Caught uncaught exception:', msg);
});

// Start bot initially
connectBot();

// Web Dashboard Server
const PORT = process.env.PORT || 3000;

// Authentic Real Minecraft Web Interface
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minecraft AFK Bot &mdash; Real Minecraft Live Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet">
  <style>
    :root {
      --mc-dirt: #866043;
      --mc-stone: #4e4e4e;
      --mc-dark-stone: #2b2b2b;
      --mc-border-light: #ffffff;
      --mc-border-dark: #373737;
      --mc-bg: #141414;
      --mc-green: #55ff55;
      --mc-gold: #ffaa00;
      --mc-red: #ff5555;
      --mc-aqua: #55ffff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--mc-bg);
      background-image: 
        linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.6)),
        radial-gradient(#2c2c2c 15%, transparent 16%);
      background-size: 16px 16px;
      color: #f1f1f1;
      font-family: 'Press Start 2P', monospace;
      font-size: 11px;
      line-height: 1.6;
      image-rendering: pixelated;
      padding-bottom: 50px;
    }
    .font-alt { font-family: 'VT323', monospace; font-size: 16px; }

    /* Minecraft Panels & Windows */
    .mc-panel {
      background: #c6c6c6;
      border-top: 3px solid #ffffff;
      border-left: 3px solid #ffffff;
      border-right: 3px solid #555555;
      border-bottom: 3px solid #555555;
      box-shadow: inset 2px 2px 0px #dbdbdb, inset -2px -2px 0px #3f3f3f, 0 4px 12px rgba(0,0,0,0.5);
      color: #2e2e2e;
      padding: 14px;
      border-radius: 2px;
    }
    .mc-panel-dark {
      background: #1f1f23;
      border-top: 3px solid #3c3c43;
      border-left: 3px solid #3c3c43;
      border-right: 3px solid #0f0f12;
      border-bottom: 3px solid #0f0f12;
      color: #f1f1f1;
      padding: 14px;
      box-shadow: inset 2px 2px 0px #2a2a30, 0 4px 14px rgba(0,0,0,0.6);
    }
    .mc-panel-title {
      font-size: 12px;
      color: #ffff55;
      text-shadow: 2px 2px 0px #3f3f00;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Authentic Minecraft Stone Button */
    .mc-btn {
      font-family: 'Press Start 2P', monospace;
      font-size: 10px;
      background: #737373;
      color: #ffffff;
      text-shadow: 1px 1px 0px #222222;
      border-top: 2px solid #a8a8a8;
      border-left: 2px solid #a8a8a8;
      border-right: 2px solid #3c3c3c;
      border-bottom: 2px solid #3c3c3c;
      padding: 8px 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      user-select: none;
      transition: none;
    }
    .mc-btn:hover {
      background: #878787;
      border-top-color: #bebebe;
      border-left-color: #bebebe;
      border-right-color: #2b2b2b;
      border-bottom-color: #2b2b2b;
      color: #ffffa0;
    }
    .mc-btn:active {
      background: #555555;
      border-top: 2px solid #222222;
      border-left: 2px solid #222222;
      border-right: 2px solid #888888;
      border-bottom: 2px solid #888888;
      transform: translateY(1px);
    }
    .mc-btn-green {
      background: #2e7d32;
      border-top-color: #4caf50;
      border-left-color: #4caf50;
      border-right-color: #1b5e20;
      border-bottom-color: #1b5e20;
    }
    .mc-btn-green:hover { background: #388e3c; }
    .mc-btn-red {
      background: #c62828;
      border-top-color: #ef5350;
      border-left-color: #ef5350;
      border-right-color: #8e0000;
      border-bottom-color: #8e0000;
    }
    .mc-btn-red:hover { background: #d32f2f; }

    /* Minecraft Slot */
    .mc-slot {
      width: 40px;
      height: 40px;
      background: #8b8b8b;
      border-top: 2px solid #373737;
      border-left: 2px solid #373737;
      border-right: 2px solid #ffffff;
      border-bottom: 2px solid #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    header {
      background: #25252b;
      border-bottom: 3px solid #3a3a44;
      padding: 12px 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 10px rgba(0,0,0,0.5);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-icon {
      width: 40px; height: 40px;
      background: #4a6730;
      border-top: 2px solid #739f4e;
      border-left: 2px solid #739f4e;
      border-right: 2px solid #2d401c;
      border-bottom: 2px solid #2d401c;
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
    }
    .brand h1 { font-size: 13px; color: #ffffff; text-shadow: 2px 2px 0px #000; }
    .brand p { font-size: 9px; color: #a0a0a0; margin-top: 3px; }

    .status-badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 12px; border: 2px solid; font-size: 10px;
    }
    .badge-online { background: #1b4d24; border-color: #4caf50; color: #55ff55; }
    .badge-reconnecting { background: #4d3a1b; border-color: #ff9800; color: #ffaa00; }
    .badge-error { background: #4d1b1b; border-color: #f44336; color: #ff5555; }
    .badge-offline { background: #2b2b2b; border-color: #616161; color: #aaaaaa; }

    .container { max-width: 1200px; margin: 20px auto; padding: 0 16px; display: flex; flex-direction: column; gap: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }

    /* Inputs */
    input[type="text"], input[type="number"] {
      background: #000000;
      border-top: 2px solid #373737;
      border-left: 2px solid #373737;
      border-right: 2px solid #ffffff;
      border-bottom: 2px solid #ffffff;
      color: #ffffff;
      font-family: 'Press Start 2P', monospace;
      font-size: 10px;
      padding: 8px 10px;
      outline: none;
    }
    input[type="text"]:focus, input[type="number"]:focus {
      border-color: #55ff55;
    }

    /* Radar Box */
    .radar-box {
      background: #102613;
      border: 2px solid #2e7d32;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: pulseBorder 2s infinite;
    }
    @keyframes pulseBorder {
      0%, 100% { border-color: #2e7d32; }
      50% { border-color: #55ff55; }
    }

    /* HUD Vitals */
    .vitals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .vital-box {
      background: #141416;
      border: 2px solid #28282c;
      padding: 10px;
    }
    .vital-header { display: flex; justify-content: space-between; font-size: 9px; margin-bottom: 6px; }
    .hearts-row, .food-row, .armor-row { display: flex; gap: 2px; }
    .xp-bar-container { margin-top: 10px; }
    .xp-bar-bg {
      width: 100%; height: 8px; background: #000000;
      border: 1px solid #333; position: relative; overflow: hidden;
    }
    .xp-bar-fill {
      height: 100%; width: 0%;
      background: linear-gradient(90deg, #55ff55, #80ff00);
      box-shadow: 0 0 8px #55ff55;
      transition: width 0.3s;
    }

    /* Coordinates */
    .coords-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 10px; }
    .coord-item { background: #121214; border: 1px solid #2a2a2e; padding: 6px; text-align: center; }
    .coord-label { font-size: 8px; color: #888; display: block; margin-bottom: 2px; }
    .coord-val { font-size: 10px; color: #55ffff; }

    /* Chat */
    .chat-container { display: flex; flex-direction: column; gap: 8px; }
    .chat-box {
      height: 240px;
      background: rgba(0, 0, 0, 0.75);
      border: 2px solid #333333;
      padding: 10px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 10px;
    }
    .chat-msg { line-height: 1.4; word-break: break-word; }
    .chat-time { color: #888888; font-size: 8px; margin-right: 4px; }
    .chat-sender { color: #ffaa00; text-shadow: 1px 1px 0 #000; }
    .chat-sender.bot { color: #55ff55; }
    .chat-sender.server { color: #ff55ff; }

    /* Logs */
    .log-box {
      height: 180px;
      background: #09090b;
      border: 2px solid #27272a;
      padding: 8px;
      overflow-y: auto;
      font-size: 9px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .log-entry { line-height: 1.4; }
    .log-info { color: #a1a1aa; }
    .log-success { color: #55ff55; }
    .log-warn { color: #ffaa00; }
    .log-error { color: #ff5555; }

    /* Toggle switch */
    .toggle-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 0; border-bottom: 1px solid #2a2a30; font-size: 9px;
    }
    .toggle-row:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">⛏️</div>
      <div>
        <h1>MINECRAFT 24/7 AFK BOT</h1>
        <p><span id="header-host">alamincraft.aternos.me:26832</span> &bull; UPTIME: <span id="header-uptime">00:00:00</span></p>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <div id="status-badge" class="status-badge badge-offline">
        <span id="status-text">OFFLINE</span>
      </div>
      <button class="mc-btn mc-btn-green" onclick="reconnectNow()">⚡ RECONNECT</button>
    </div>
  </header>

  <div class="container">
    <!-- 1-CLICK ATERNOS SERVER LAUNCHER & AUTO-JOIN RADAR -->
    <div class="mc-panel-dark" style="border-color: #4caf50;">
      <div class="mc-panel-title">
        <span>⚡ 1-CLICK ATERNOS SERVER LAUNCHER &amp; AUTO-JOIN RADAR</span>
        <span style="font-size: 9px; color: #55ff55;">SOLVES SERVER AUTO-STOP</span>
      </div>
      <p style="font-size: 9px; color: #cccccc; margin-bottom: 12px; line-height: 1.6;">
        Aternos turns offline servers into standby. Click the big green button below: it opens the official Aternos control panel and simultaneously activates our <strong>High-Frequency Radar</strong>. The moment your server boots, the bot joins automatically!
      </p>

      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
        <button class="mc-btn mc-btn-green" style="font-size: 11px; padding: 12px 18px;" onclick="launchOneClickServer()">
          🚀 1-CLICK: START SERVER &amp; AUTO-JOIN
        </button>
        <button class="mc-btn" onclick="toggleRadar()">
          <span id="radar-btn-text">📡 START RADAR ONLY</span>
        </button>
        <button class="mc-btn" onclick="pingServer()">
          🔍 CHECK SERVER PING
        </button>
      </div>

      <!-- Radar Active Display -->
      <div id="radar-container" class="radar-box" style="display: none; margin-top: 12px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: #55ff55;">📡 RADAR ACTIVE &mdash; POLLING EVERY 3 SECONDS</span>
          <button class="mc-btn mc-btn-red" style="font-size: 8px; padding: 4px 8px;" onclick="stopRadar()">STOP RADAR</button>
        </div>
        <p id="radar-msg" style="font-size: 9px; color: #ffffff;">Radar started...</p>
      </div>
    </div>

    <!-- Duplicate Login Alert Banner (If Applicable) -->
    <div id="duplicate-login-banner" class="mc-panel" style="background: #4a2800; border-color: #ffaa00; color: #ffffff; display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="color: #ffaa00; font-weight: bold;">⚠️ DUPLICATE LOGIN DETECTED &amp; AUTO-RESOLVED</span>
          <p id="duplicate-login-text" style="font-size: 9px; margin-top: 4px; color: #ffe6a0;"></p>
        </div>
        <button class="mc-btn mc-btn-green" onclick="generateRandomNameAndConnect()">🎲 NEW NAME &amp; RETRY</button>
      </div>
    </div>

    <!-- SERVER IP, PORT & BOT NAME CONFIGURATION -->
    <div class="mc-panel-dark">
      <div class="mc-panel-title">
        <span>⚙️ SERVER IP, PORT &amp; BOT CREDENTIALS</span>
        <span id="cfg-active-target" style="font-size: 9px; color: #55ff55;">Target: alamincraft.aternos.me:26832</span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;">
        <div>
          <label style="font-size: 8px; color: #aaaaaa; display: block; margin-bottom: 4px;">SERVER HOST / IP:</label>
          <input type="text" id="cfg-host" value="alamincraft.aternos.me" style="width: 100%;">
        </div>
        <div>
          <label style="font-size: 8px; color: #aaaaaa; display: block; margin-bottom: 4px;">SERVER PORT:</label>
          <input type="number" id="cfg-port" value="26832" style="width: 100%;">
        </div>
        <div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <label style="font-size: 8px; color: #aaaaaa;">BOT USERNAME:</label>
            <a href="javascript:void(0)" onclick="generateRandomName()" style="color: #55ff55; font-size: 8px; text-decoration: none;">🎲 RANDOM</a>
          </div>
          <input type="text" id="cfg-username" value="AFK_Bot_Pro" style="width: 100%;">
        </div>
      </div>

      <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 14px;">
        <button class="mc-btn mc-btn-green" onclick="saveAndConnect()">💾 CONNECT &amp; SAVE</button>
        <button class="mc-btn mc-btn-red" onclick="disconnectBot()">🛑 DISCONNECT</button>
      </div>
    </div>

    <!-- ATERNOS ANTI-DETECTION & ANTI-AFK SETTINGS -->
    <div class="mc-panel-dark">
      <div class="mc-panel-title">
        <span>🛡️ ATERNOS ANTI-DETECTION PATROL AI</span>
        <span style="font-size: 8px; color: #55ffff;">PREVENTS AUTO-STOP</span>
      </div>
      <p style="font-size: 8px; color: #aaaaaa; margin-bottom: 10px;">
        Aternos servers check if players stay stationary on the same coordinate. When enabled, the bot patrols between adjacent blocks and cycles held items to keep the server alive indefinitely.
      </p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px;">
        <div class="toggle-row">
          <span>Block-Crossing Patrol (Move across block borders)</span>
          <input type="checkbox" id="cfg-anti-patrol" checked onchange="updateAntiAfkSettings()">
        </div>
        <div class="toggle-row">
          <span>Cycle Hotbar Slots (Resets idle timer packets)</span>
          <input type="checkbox" id="cfg-anti-hotbar" checked onchange="updateAntiAfkSettings()">
        </div>
        <div class="toggle-row">
          <span>Auto-Eat Food (When hunger &le; 14)</span>
          <input type="checkbox" id="cfg-auto-eat" checked onchange="updateAntiAfkSettings()">
        </div>
        <div class="toggle-row">
          <span>Jump Periodically</span>
          <input type="checkbox" id="cfg-anti-jump" checked onchange="updateAntiAfkSettings()">
        </div>
        <div class="toggle-row">
          <span>Natural Head Rotation (Yaw/Pitch)</span>
          <input type="checkbox" id="cfg-anti-rotate" checked onchange="updateAntiAfkSettings()">
        </div>
        <div class="toggle-row">
          <span>Arm Swing Rhythm</span>
          <input type="checkbox" id="cfg-anti-swing" checked onchange="updateAntiAfkSettings()">
        </div>
      </div>
    </div>

    <!-- VITALS & CHAT GRID -->
    <div class="grid">
      <!-- Real Minecraft HUD -->
      <div class="mc-panel-dark">
        <div class="mc-panel-title">
          <span>❤️ VITALS &amp; TELEMETRY</span>
          <span id="ping-text" style="font-size: 9px; color: #55ff55;">PING: 0ms</span>
        </div>

        <!-- Armor & Oxygen -->
        <div style="margin-bottom: 8px;">
          <div style="font-size: 8px; color: #aaaaaa; margin-bottom: 2px;">ARMOR DEFENSE:</div>
          <div id="armor-row" class="armor-row">🛡️🛡️🛡️🛡️🛡️🛡️🛡️🛡️🛡️🛡️</div>
        </div>

        <div class="vitals-grid">
          <div class="vital-box">
            <div class="vital-header">
              <span style="color: #ff5555;">HEALTH</span>
              <span id="health-val">20 / 20 HP</span>
            </div>
            <div id="hearts-row" class="hearts-row"></div>
          </div>
          <div class="vital-box">
            <div class="vital-header">
              <span style="color: #ffaa00;">FOOD</span>
              <span id="food-val">20 / 20</span>
            </div>
            <div id="food-row" class="food-row"></div>
          </div>
        </div>

        <div class="xp-bar-container">
          <div style="display: flex; justify-content: space-between; font-size: 9px; margin-bottom: 4px;">
            <span style="color: #55ff55;">XP LEVEL <span id="xp-level">0</span></span>
            <span id="xp-progress">0%</span>
          </div>
          <div class="xp-bar-bg">
            <div id="xp-bar-fill" class="xp-bar-fill"></div>
          </div>
        </div>

        <!-- Coordinates -->
        <div class="coords-grid">
          <div class="coord-item"><span class="coord-label">X</span><span id="pos-x" class="coord-val">--</span></div>
          <div class="coord-item"><span class="coord-label">Y</span><span id="pos-y" class="coord-val">--</span></div>
          <div class="coord-item"><span class="coord-label">Z</span><span id="pos-z" class="coord-val">--</span></div>
          <div class="coord-item"><span class="coord-label">YAW</span><span id="pos-yaw" class="coord-val">--</span></div>
        </div>

        <!-- In-game Actions -->
        <div style="margin-top: 12px;">
          <span style="font-size: 8px; color: #aaaaaa; display: block; margin-bottom: 6px;">MANUAL IN-GAME CONTROLS:</span>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            <button class="mc-btn" onclick="doAction('jump')">🦘 JUMP</button>
            <button class="mc-btn" onclick="doAction('swing')">🗡️ SWING</button>
            <button class="mc-btn" onclick="doAction('rotate')">👀 LOOK</button>
            <button class="mc-btn" onclick="doAction('sneak')">🧎 SNEAK</button>
            <button class="mc-btn" onclick="doAction('step')">👟 PATROL</button>
            <button class="mc-btn" onclick="doAction('eat')">🥩 EAT</button>
            <button class="mc-btn" onclick="doAction('respawn')">✨ RESPAWN</button>
          </div>
        </div>
      </div>

      <!-- Live In-Game Chat -->
      <div class="mc-panel-dark">
        <div class="mc-panel-title">
          <span>💬 LIVE IN-GAME CHAT STREAM</span>
          <span style="font-size: 8px; color: #55ffff;">MINECRAFT FEED</span>
        </div>

        <div class="chat-container">
          <div id="chat-box" class="chat-box">
            <div style="color: #888888; text-align: center; margin-top: 100px;">Waiting for chat messages...</div>
          </div>

          <div style="display: flex; gap: 6px;">
            <input type="text" id="chat-input" placeholder="Type chat or /command..." style="flex: 1;" onkeydown="if(event.key==='Enter')sendChat()">
            <button class="mc-btn mc-btn-green" onclick="sendChat()">SEND</button>
          </div>

          <!-- Command Chips -->
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;">
            <button class="mc-btn" style="font-size: 8px; padding: 4px 6px;" onclick="sendQuickCmd('/spawn')">/spawn</button>
            <button class="mc-btn" style="font-size: 8px; padding: 4px 6px;" onclick="sendQuickCmd('/help')">/help</button>
            <button class="mc-btn" style="font-size: 8px; padding: 4px 6px;" onclick="sendQuickCmd('/afk')">/afk</button>
            <button class="mc-btn" style="font-size: 8px; padding: 4px 6px;" onclick="sendQuickCmd('Hello from AFK bot!')">Say Hi</button>
          </div>
        </div>
      </div>
    </div>

    <!-- INVENTORY & LOGS -->
    <div class="grid">
      <!-- Players & Inventory -->
      <div class="mc-panel-dark">
        <div class="mc-panel-title">
          <span>👥 PLAYERS ONLINE (<span id="player-count">0</span>)</span>
        </div>
        <div id="players-list" style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 36px; margin-bottom: 14px;">
          <span style="color: #666;">No players detected</span>
        </div>

        <div class="mc-panel-title">
          <span>🎒 BOT INVENTORY</span>
        </div>
        <div id="inventory-list" style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 40px;">
          <span style="color: #666;">Inventory is empty</span>
        </div>
      </div>

      <!-- Logs -->
      <div class="mc-panel-dark">
        <div class="mc-panel-title">
          <span>📜 ACTIVITY LOGS</span>
          <button class="mc-btn" style="font-size: 8px; padding: 3px 6px;" onclick="clearLogs()">CLEAR</button>
        </div>
        <div id="log-box" class="log-box"></div>
      </div>
    </div>
  </div>

  <script>
    function formatTime(sec) {
      const h = Math.floor(sec / 3600).toString().padStart(2, '0');
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
      const s = (sec % 60).toString().padStart(2, '0');
      return h + ':' + m + ':' + s;
    }

    // Pixel Heart Generator
    function getHeartSvg(type) {
      const isFull = type === 'full';
      const isEmpty = type === 'empty';
      return '<svg viewBox="0 0 9 9" style="width:18px;height:18px;image-rendering:pixelated;shape-rendering:crispEdges;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.8));">' +
        '<rect x="1" y="0" width="2" height="1" fill="#000" /><rect x="5" y="0" width="2" height="1" fill="#000" />' +
        '<rect x="0" y="1" width="1" height="3" fill="#000" /><rect x="3" y="1" width="2" height="2" fill="#000" /><rect x="7" y="1" width="1" height="3" fill="#000" />' +
        '<rect x="1" y="4" width="1" height="2" fill="#000" /><rect x="6" y="4" width="1" height="2" fill="#000" />' +
        '<rect x="2" y="6" width="1" height="1" fill="#000" /><rect x="5" y="6" width="1" height="1" fill="#000" /><rect x="3" y="7" width="2" height="1" fill="#000" />' +
        '<rect x="1" y="1" width="2" height="3" fill="#373737" /><rect x="5" y="1" width="2" height="3" fill="#373737" /><rect x="2" y="4" width="4" height="2" fill="#373737" /><rect x="3" y="6" width="2" height="1" fill="#373737" />' +
        '<rect x="1" y="1" width="1" height="1" fill="#fff" />' +
        (!isEmpty ? '<rect x="1" y="1" width="2" height="3" fill="#e01010" /><rect x="2" y="4" width="2" height="2" fill="#e01010" /><rect x="3" y="6" width="1" height="1" fill="#e01010" /><rect x="1" y="1" width="1" height="1" fill="#fff" /><rect x="1" y="3" width="1" height="1" fill="#880808" /><rect x="2" y="5" width="1" height="1" fill="#880808" />' : '') +
        (isFull ? '<rect x="5" y="1" width="2" height="3" fill="#e01010" /><rect x="3" y="3" width="3" height="3" fill="#e01010" /><rect x="4" y="6" width="1" height="1" fill="#e01010" /><rect x="6" y="3" width="1" height="1" fill="#880808" /><rect x="5" y="5" width="1" height="1" fill="#880808" />' : '') +
      '</svg>';
    }

    // Pixel Drumstick Generator
    function getDrumstickSvg(type) {
      const isHalf = type === 'half';
      const isEmpty = type === 'empty';
      return '<svg viewBox="0 0 9 9" style="width:18px;height:18px;image-rendering:pixelated;shape-rendering:crispEdges;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.8));">' +
        '<rect x="2" y="1" width="4" height="1" fill="#000" /><rect x="1" y="2" width="1" height="3" fill="#000" /><rect x="6" y="2" width="1" height="2" fill="#000" /><rect x="2" y="5" width="4" height="1" fill="#000" />' +
        '<rect x="6" y="4" width="2" height="1" fill="#000" /><rect x="7" y="5" width="1" height="2" fill="#000" /><rect x="5" y="6" width="2" height="1" fill="#000" /><rect x="6" y="7" width="2" height="1" fill="#000" />' +
        '<rect x="2" y="2" width="4" height="3" fill="#373737" /><rect x="6" y="5" width="1" height="2" fill="#505050" />' +
        (!isEmpty ? '<rect x="2" y="2" width="4" height="3" fill="#b05417" /><rect x="3" y="2" width="2" height="1" fill="#d97a26" /><rect x="2" y="3" width="1" height="1" fill="#d97a26" /><rect x="2" y="4" width="4" height="1" fill="#6f2b05" /><rect x="6" y="5" width="1" height="2" fill="#dedede" /><rect x="7" y="6" width="1" height="1" fill="#fff" /><rect x="5" y="6" width="1" height="1" fill="#999" />' : '') +
        (isHalf ? '<rect x="4" y="2" width="2" height="3" fill="#373737" />' : '') +
      '</svg>';
    }

    let hasLoadedConfig = false;

    function renderStatus(data) {
      if (!data) return;
      const isOnline = data.state === 'online';
      const badge = document.getElementById('status-badge');
      const text = document.getElementById('status-text');

      badge.className = 'status-badge ' + (
        isOnline ? 'badge-online' :
        data.state === 'reconnecting' ? 'badge-reconnecting' :
        data.state === 'error' ? 'badge-error' :
        data.state === 'kicked' ? 'badge-error' : 'badge-offline'
      );

      text.innerText = isOnline ? 'ONLINE' :
        data.state === 'reconnecting' ? ('RECONNECTING (' + (data.reconnectCountdown||0) + 's)') :
        data.state === 'connecting' ? 'CONNECTING...' :
        data.state === 'kicked' ? 'KICKED' :
        data.state === 'error' ? 'ERROR / STANDBY' : 'OFFLINE';

      document.getElementById('header-uptime').innerText = formatTime(data.uptime || 0);
      document.getElementById('ping-text').innerText = 'PING: ' + (data.ping || 0) + 'ms';

      // Duplicate Login Notice
      const dupBanner = document.getElementById('duplicate-login-banner');
      if (data.kickReason && data.kickReason.toLowerCase().includes('duplicate')) {
        dupBanner.style.display = 'block';
        document.getElementById('duplicate-login-text').innerText = data.kickReason;
      } else {
        dupBanner.style.display = 'none';
      }

      // Radar status
      const radarEl = document.getElementById('radar-container');
      const radarBtnText = document.getElementById('radar-btn-text');
      if (data.watcher?.active) {
        radarEl.style.display = 'flex';
        document.getElementById('radar-msg').innerText = data.watcher.message || 'Scanning server...';
        radarBtnText.innerText = '📡 RADAR RUNNING';
      } else {
        radarEl.style.display = 'none';
        radarBtnText.innerText = '📡 START RADAR ONLY';
      }

      // Hearts
      const hp = data.health || 20;
      document.getElementById('health-val').innerText = Math.round(hp) + ' / 20 HP';
      let heartsHtml = '';
      for (let i = 0; i < 10; i++) {
        const val = (i + 1) * 2;
        const type = hp >= val ? 'full' : (hp >= val - 1 ? 'half' : 'empty');
        heartsHtml += getHeartSvg(type);
      }
      document.getElementById('hearts-row').innerHTML = heartsHtml;

      // Drumsticks
      const food = data.food || 20;
      document.getElementById('food-val').innerText = Math.round(food) + ' / 20';
      let foodHtml = '';
      for (let i = 0; i < 10; i++) {
        const val = (i + 1) * 2;
        const type = food >= val ? 'full' : (food >= val - 1 ? 'half' : 'empty');
        foodHtml += getDrumstickSvg(type);
      }
      document.getElementById('food-row').innerHTML = foodHtml;

      // XP
      document.getElementById('xp-level').innerText = data.xp?.level || 0;
      document.getElementById('xp-progress').innerText = (data.xp?.progress || 0) + '%';
      document.getElementById('xp-bar-fill').style.width = (data.xp?.progress || 0) + '%';

      // Coords
      document.getElementById('pos-x').innerText = data.position?.x ?? '--';
      document.getElementById('pos-y').innerText = data.position?.y ?? '--';
      document.getElementById('pos-z').innerText = data.position?.z ?? '--';
      document.getElementById('pos-yaw').innerText = (data.position?.yaw ?? '--') + '°';

      // Players
      const pl = data.players || [];
      document.getElementById('player-count').innerText = pl.length;
      const plEl = document.getElementById('players-list');
      if (pl.length > 0) {
        plEl.innerHTML = pl.map(p => '<span style="background: #222; border: 1px solid #4caf50; padding: 4px 8px; color: #55ff55;">' + p + '</span>').join('');
      } else {
        plEl.innerHTML = '<span style="color: #666;">No players detected</span>';
      }

      // Inventory
      const inv = data.inventory || [];
      const invEl = document.getElementById('inventory-list');
      if (inv.length > 0) {
        invEl.innerHTML = inv.map(i => '<span style="background: #2a2a30; border: 1px solid #444; padding: 4px 6px; font-size: 8px;">' + (i.displayName || i.name) + (i.count > 1 ? ' &times;' + i.count : '') + '</span>').join('');
      } else {
        invEl.innerHTML = '<span style="color: #666;">Inventory is empty</span>';
      }

      if (!hasLoadedConfig && data.config) {
        document.getElementById('cfg-host').value = data.config.host || 'alamincraft.aternos.me';
        document.getElementById('cfg-port').value = data.config.port || 26832;
        document.getElementById('cfg-username').value = data.config.username || 'AFK_Bot_Pro';
        if (data.config.antiAfk) {
          document.getElementById('cfg-anti-patrol').checked = data.config.antiAfk.aternosAntiDetect !== false;
          document.getElementById('cfg-anti-hotbar').checked = data.config.antiAfk.cycleHotbar !== false;
          document.getElementById('cfg-anti-jump').checked = Boolean(data.config.antiAfk.jump);
          document.getElementById('cfg-anti-rotate').checked = Boolean(data.config.antiAfk.rotate);
          document.getElementById('cfg-anti-swing').checked = Boolean(data.config.antiAfk.swing);
        }
        document.getElementById('cfg-auto-eat').checked = Boolean(data.config.autoEat);
        hasLoadedConfig = true;
      }

      if (data.config) {
        document.getElementById('header-host').innerText = data.config.host + ':' + data.config.port;
        document.getElementById('cfg-active-target').innerText = 'Target: ' + data.config.host + ':' + data.config.port + ' (' + data.config.username + ')';
      }
    }

    function addChatMsg(msg) {
      const box = document.getElementById('chat-box');
      const el = document.createElement('div');
      el.className = 'chat-msg';
      const senderClass = msg.isSystem ? 'server' : (msg.sender === document.getElementById('cfg-username').value ? 'bot' : '');
      el.innerHTML = '<span class="chat-time">' + msg.time + '</span>' +
        '<span class="chat-sender ' + senderClass + '">&lt;' + msg.sender + '&gt;</span> ' +
        '<span>' + msg.text + '</span>';
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    }

    function addLogMsg(log) {
      const box = document.getElementById('log-box');
      const el = document.createElement('div');
      el.className = 'log-entry log-' + log.level;
      el.innerText = '[' + log.time + '] [' + log.level.toUpperCase() + '] ' + log.message;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    }

    function clearLogs() {
      document.getElementById('log-box').innerHTML = '';
    }

    function sendChat() {
      const inp = document.getElementById('chat-input');
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
    }

    function sendQuickCmd(cmd) {
      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cmd })
      });
    }

    function doAction(action) {
      fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
    }

    function reconnectNow() {
      fetch('/api/reconnect', { method: 'POST' });
    }

    function generateRandomName() {
      const names = ['Miner', 'Steve', 'Alex', 'Shadow', 'Ghost', 'Pro', 'Craft', 'Legend', 'Ninja', 'Titan'];
      const num = Math.floor(100 + Math.random() * 900);
      document.getElementById('cfg-username').value = names[Math.floor(Math.random() * names.length)] + '_AFK_' + num;
    }

    function generateRandomNameAndConnect() {
      generateRandomName();
      saveAndConnect();
    }

    function saveAndConnect() {
      const host = document.getElementById('cfg-host').value.trim();
      const port = Number(document.getElementById('cfg-port').value);
      const username = document.getElementById('cfg-username').value.trim();
      if (!host || !port || !username) return alert('Enter Host, Port and Username!');

      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host, port, username,
          autoEat: document.getElementById('cfg-auto-eat').checked,
          antiAfk: {
            aternosAntiDetect: document.getElementById('cfg-anti-patrol').checked,
            cycleHotbar: document.getElementById('cfg-anti-hotbar').checked,
            jump: document.getElementById('cfg-anti-jump').checked,
            rotate: document.getElementById('cfg-anti-rotate').checked,
            swing: document.getElementById('cfg-anti-swing').checked,
          }
        })
      });
    }

    function updateAntiAfkSettings() {
      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoEat: document.getElementById('cfg-auto-eat').checked,
          antiAfk: {
            aternosAntiDetect: document.getElementById('cfg-anti-patrol').checked,
            cycleHotbar: document.getElementById('cfg-anti-hotbar').checked,
            jump: document.getElementById('cfg-anti-jump').checked,
            rotate: document.getElementById('cfg-anti-rotate').checked,
            swing: document.getElementById('cfg-anti-swing').checked,
          }
        })
      });
    }

    function disconnectBot() {
      fetch('/api/disconnect', { method: 'POST' });
    }

    function pingServer() {
      const host = document.getElementById('cfg-host').value.trim();
      const port = Number(document.getElementById('cfg-port').value);
      fetch('/api/server/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port })
      }).then(r => r.json()).then(res => {
        alert(res.online ? 'Server is ONLINE! Latency: ' + res.latency + 'ms' : 'Server Status: ' + (res.error || 'Offline'));
      });
    }

    // 1-Click Launch Server & Auto-Join Radar
    function launchOneClickServer() {
      // 1. Open Aternos server page in new tab
      try {
        window.open('https://aternos.org/servers/', '_blank');
      } catch {}

      // 2. Start automated radar
      startRadar();
    }

    function startRadar() {
      const host = document.getElementById('cfg-host').value.trim();
      const port = Number(document.getElementById('cfg-port').value);
      fetch('/api/server/watch-and-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port })
      });
    }

    function stopRadar() {
      fetch('/api/server/stop-watch', { method: 'POST' });
    }

    function toggleRadar() {
      const radarEl = document.getElementById('radar-container');
      if (radarEl.style.display === 'flex') {
        stopRadar();
      } else {
        startRadar();
      }
    }

    // SSE Stream
    const ev = new EventSource('/api/events');
    ev.addEventListener('status', e => renderStatus(JSON.parse(e.data)));
    ev.addEventListener('watcher', e => {
      const w = JSON.parse(e.data);
      const radarEl = document.getElementById('radar-container');
      if (w.active) {
        radarEl.style.display = 'flex';
        document.getElementById('radar-msg').innerText = w.message || 'Scanning...';
      } else {
        radarEl.style.display = 'none';
      }
    });
    ev.addEventListener('chat', e => addChatMsg(JSON.parse(e.data)));
    ev.addEventListener('log', e => addLogMsg(JSON.parse(e.data)));

    // Polling fallback
    setInterval(() => {
      fetch('/api/status').then(r => r.json()).then(renderStatus).catch(() => {});
    }, 2500);

    fetch('/api/status').then(r => r.json()).then(renderStatus);
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // SSE Stream
  if (req.url === '/api/events' || req.url === '/api/bot/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.push(res);
    res.write(`event: status\ndata: ${JSON.stringify(getBotSnapshot())}\n\n`);

    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
    return;
  }

  // Status API
  if (req.url === '/api/status' || req.url === '/api/bot/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getBotSnapshot()));
  }

  // 1-Click Server Watcher APIs
  if (req.url === '/api/server/watch-and-connect' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { host, port } = JSON.parse(body || '{}');
        startServerWatcher(host, port);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Server watcher radar activated' }));
      } catch {
        startServerWatcher();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }
    });
    return;
  }

  if (req.url === '/api/server/stop-watch' && req.method === 'POST') {
    stopServerWatcher();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'Watcher stopped' }));
  }

  if (req.url === '/api/server/watch-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      active: serverWatcherActive,
      stage: serverWatcherStage,
      message: serverWatcherMessage,
    }));
  }

  // Ping API
  if ((req.url === '/api/ping' || req.url === '/api/server/ping') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let host = CONFIG.host;
      let port = CONFIG.port;
      try {
        const parsed = JSON.parse(body);
        if (parsed.host) host = parsed.host;
        if (parsed.port) port = parsed.port;
      } catch {}

      isServerOnline(host, port).then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    return;
  }

  // Reconnect API
  if ((req.url === '/api/reconnect' || req.url === '/api/bot/connect') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { host, port, username, autoEat, antiAfk } = JSON.parse(body || '{}');
        if (host) CONFIG.host = host.trim();
        if (port) CONFIG.port = Number(port);
        if (username) CONFIG.username = username.trim();
        if (typeof autoEat === 'boolean') CONFIG.autoEat = autoEat;
        if (antiAfk) CONFIG.antiAfk = { ...CONFIG.antiAfk, ...antiAfk };
      } catch {}
      connectBot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, config: CONFIG }));
    });
    return;
  }

  // Update IP, Port, Username Config API
  if ((req.url === '/api/config' || req.url === '/api/bot/save-config') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { host, port, username, autoEat, antiAfk } = JSON.parse(body);
        if (host) CONFIG.host = host.trim();
        if (port) CONFIG.port = Number(port);
        if (username) CONFIG.username = username.trim();
        if (typeof autoEat === 'boolean') CONFIG.autoEat = autoEat;
        if (antiAfk) {
          CONFIG.antiAfk = { ...CONFIG.antiAfk, ...antiAfk };
        }
        addLog('info', `Config updated: Target Server ${CONFIG.host}:${CONFIG.port}, Bot "${CONFIG.username}"`);
        connectBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: CONFIG }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid settings body' }));
      }
    });
    return;
  }

  // Disconnect API
  if ((req.url === '/api/disconnect' || req.url === '/api/bot/disconnect') && req.method === 'POST') {
    CONFIG.autoReconnect = false;
    clearTimers();
    cleanupBotSocket();
    botStatus = 'offline';
    connectedAt = null;
    lastError = null;
    lastKickReason = null;
    addLog('info', 'User requested bot disconnection.');
    broadcastSSE('status', getBotSnapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Chat API
  if ((req.url === '/api/chat' || req.url === '/api/bot/chat') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { message } = JSON.parse(body);
        if (bot && botStatus === 'online' && message) {
          bot.chat(message);
          addChat(CONFIG.username, message, false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot is not online' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid body' }));
      }
    });
    return;
  }

  // Action API
  if ((req.url === '/api/action' || req.url === '/api/bot/action') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { action } = JSON.parse(body);
        if (bot && botStatus === 'online') {
          if (action === 'jump') {
            bot.setControlState('jump', true);
            setTimeout(() => bot && bot.setControlState('jump', false), 350);
            addLog('info', 'Manual Action: Jump triggered');
          } else if (action === 'swing') {
            bot.swingArm('right');
            addLog('info', 'Manual Action: Arm swing triggered');
          } else if (action === 'sneak') {
            const current = bot.getControlState('sneak') || false;
            bot.setControlState('sneak', !current);
            addLog('info', `Manual Action: Sneak toggled to ${!current}`);
          } else if (action === 'rotate') {
            const yaw = (Math.random() - 0.5) * Math.PI * 2;
            const pitch = (Math.random() - 0.5) * 0.8;
            bot.look(yaw, pitch, true).catch(() => {});
            addLog('info', 'Manual Action: Rotated orientation');
          } else if (action === 'step') {
            bot.setControlState('forward', true);
            setTimeout(() => {
              if (bot) {
                bot.setControlState('forward', false);
                bot.setControlState('back', true);
                setTimeout(() => bot && bot.setControlState('back', false), 300);
              }
            }, 300);
            addLog('info', 'Manual Action: Step patrol triggered');
          } else if (action === 'eat') {
            attemptAutoEat();
            addLog('info', 'Manual Action: Eat attempted');
          } else if (action === 'respawn') {
            bot.respawn();
            addLog('info', 'Manual Action: Respawn requested');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bot not online' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid body' }));
      }
    });
    return;
  }

  // Home route: Serve Dashboard HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DASHBOARD_HTML);
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`=============================================================`);
  console.log(`🚀 Minecraft AFK Bot & Real Minecraft Dashboard Online!`);
  console.log(`🌐 Web URL: http://0.0.0.0:${PORT}`);
  console.log(`🎮 Target Server: ${CONFIG.host}:${CONFIG.port}`);
  console.log(`🛡️ Aternos Anti-Detection Patrol & 1-Click Launcher: READY`);
  console.log(`=============================================================`);
});
