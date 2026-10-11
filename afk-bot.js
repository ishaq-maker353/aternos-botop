/**
 * Standalone 24/7 Minecraft AFK Bot & Web Dashboard
 * With Live IP, Port & Username Configuration
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
  antiAfk: {
    jump: true,
    rotate: true,
    swing: true,
    sneak: false,
    walk: true,
  },
};

let bot = null;
let reconnectTimer = null;
let antiAfkInterval = null;
let botStatus = 'offline';
let lastError = null;
let connectedAt = null;
let reconnectCountdown = 0;
let reconnectCountdownInterval = null;

const chatMessages = [];
const activityLogs = [];
const sseClients = [];

function addLog(level, message) {
  const time = new Date().toLocaleTimeString();
  const entry = { id: Date.now() + Math.random(), level, message, time };
  activityLogs.push(entry);
  if (activityLogs.length > 150) activityLogs.shift();
  console.log(`[${time}] [${level.toUpperCase()}] ${message}`);
  broadcastSSE('log', entry);
}

function addChat(sender, text, isSystem = false) {
  const time = new Date().toLocaleTimeString();
  const msg = { id: Date.now() + Math.random(), sender, text, isSystem, time };
  chatMessages.push(msg);
  if (chatMessages.length > 150) chatMessages.shift();
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
  const xp = isOnline && bot.experience ? {
    level: bot.experience.level || 0,
    progress: Math.round((bot.experience.progress || 0) * 100),
  } : { level: 0, progress: 0 };

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
    name: i.displayName || i.name,
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
    xp,
    position: pos,
    players,
    inventory,
    ping,
    errorMessage: lastError,
  };
}

async function isServerOnline() {
  const ping = mcProtocol.ping || mcProtocol.default?.ping;
  if (!ping) return { online: true };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ online: false, error: 'Ping timed out' }), 4500);
    ping({ host: CONFIG.host, port: CONFIG.port, closeTimeout: 4000 }, (err, res) => {
      clearTimeout(timeout);
      if (err) return resolve({ online: false, error: err.message });
      const protocol = res?.version?.protocol;
      const desc = typeof res?.description === 'string' ? res.description : (res?.description?.text || '');
      if (protocol === -1 || desc.toLowerCase().includes('offline')) {
        return resolve({
          online: false,
          isStandby: true,
          error: 'Aternos server is in standby / offline (protocol -1). Please press Start on aternos.org.',
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

function startAntiAfk() {
  if (antiAfkInterval) clearInterval(antiAfkInterval);

  let tick = 0;
  antiAfkInterval = setInterval(() => {
    if (!bot || !bot.entity || botStatus !== 'online') return;
    tick++;

    try {
      if (CONFIG.antiAfk.swing && tick % 2 === 0) {
        bot.swingArm('right');
      }

      if (CONFIG.antiAfk.rotate && tick % 3 === 0) {
        const yaw = (Math.random() - 0.5) * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * 0.8;
        bot.look(yaw, pitch, true).catch(() => {});
      }

      if (CONFIG.antiAfk.jump && tick % 7 === 0) {
        bot.setControlState('jump', true);
        setTimeout(() => bot && bot.setControlState('jump', false), 350);
      }

      if (CONFIG.antiAfk.sneak && tick % 5 === 0) {
        bot.setControlState('sneak', true);
        setTimeout(() => bot && bot.setControlState('sneak', false), 600);
      }

      if (CONFIG.antiAfk.walk && tick % 6 === 0) {
        bot.setControlState('forward', true);
        setTimeout(() => {
          if (!bot) return;
          bot.setControlState('forward', false);
          bot.setControlState('back', true);
          setTimeout(() => bot && bot.setControlState('back', false), 250);
        }, 250);
      }

      if (CONFIG.autoEat && bot.food <= 14 && bot.inventory) {
        const food = bot.inventory.items().find(i => 
          ['bread', 'beef', 'steak', 'porkchop', 'carrot', 'apple', 'baked_potato', 'chicken', 'mutton'].some(k => i.name.includes(k))
        );
        if (food) {
          bot.equip(food, 'hand')
            .then(() => bot.consume())
            .then(() => addLog('info', `Bot ate ${food.displayName || food.name}`))
            .catch(() => {});
        }
      }
    } catch {}
  }, 2000);
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconnectCountdownInterval) clearInterval(reconnectCountdownInterval);

  botStatus = 'reconnecting';
  reconnectCountdown = Math.round(CONFIG.reconnectDelayMs / 1000);
  broadcastSSE('status', getBotSnapshot());

  reconnectCountdownInterval = setInterval(() => {
    reconnectCountdown--;
    broadcastSSE('status', getBotSnapshot());
    if (reconnectCountdown <= 0) {
      clearInterval(reconnectCountdownInterval);
      reconnectCountdownInterval = null;
      connectBot();
    }
  }, 1000);
}

async function connectBot() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (antiAfkInterval) clearInterval(antiAfkInterval);
  if (bot) {
    try {
      bot.removeAllListeners();
      bot.end();
    } catch {}
    bot = null;
  }

  botStatus = 'connecting';
  lastError = null;
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

  addLog('info', `Connecting bot to ${CONFIG.host}:${CONFIG.port} as ${CONFIG.username}...`);

  try {
    const newBot = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      auth: CONFIG.auth,
      checkTimeoutInterval: 60000,
    });
    bot = newBot;

    newBot.on('login', () => {
      addLog('success', `Logged in successfully! Loading chunks...`);
    });

    newBot.on('spawn', () => {
      botStatus = 'online';
      connectedAt = Date.now();
      const pos = newBot.entity?.position;
      const posStr = pos ? `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})` : '';
      addLog('success', `Bot spawned into server at ${posStr}! Anti-AFK engine initialized.`);
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

    newBot.on('kicked', (reason) => {
      botStatus = 'kicked';
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
      lastError = `Kicked: ${reasonStr}`;
      addLog('warn', lastError);
      scheduleReconnect();
    });

    newBot.on('error', (err) => {
      const msg = err?.message || String(err);
      botStatus = 'error';
      lastError = msg;
      addLog('error', `Bot error: ${msg}`);
      broadcastSSE('status', getBotSnapshot());
    });

    newBot.on('end', (reason) => {
      addLog('warn', `Disconnected: ${reason || 'Connection lost'}`);
      botStatus = 'offline';
      connectedAt = null;
      if (antiAfkInterval) clearInterval(antiAfkInterval);
      scheduleReconnect();
    });

  } catch (err) {
    botStatus = 'error';
    lastError = err.message;
    addLog('error', `Failed to initialize bot: ${err.message}`);
    scheduleReconnect();
  }
}

connectBot();

// Standalone Web Dashboard Server
const PORT = process.env.PORT || 3000;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minecraft AFK Bot - Live Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #111827;
      --card-border: #1f2937;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --emerald: #10b981;
      --emerald-bg: rgba(16, 185, 129, 0.15);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.15);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.15);
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding-bottom: 40px;
    }
    header {
      background: rgba(17, 24, 39, 0.85);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--card-border);
      padding: 14px 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-icon {
      width: 36px; height: 36px; background: #064e3b; border: 1px solid #059669;
      border-radius: 8px; display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    .brand h1 { font-size: 16px; font-weight: 700; color: #fff; }
    .brand p { font-size: 11px; color: var(--text-muted); font-family: monospace; }
    .status-badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .badge-online { background: var(--emerald-bg); border: 1px solid rgba(16, 185, 129, 0.4); color: var(--emerald); }
    .badge-reconnecting { background: var(--amber-bg); border: 1px solid rgba(245, 158, 11, 0.4); color: var(--amber); }
    .badge-error { background: var(--red-bg); border: 1px solid rgba(239, 68, 68, 0.4); color: var(--red); }
    .badge-offline { background: #1f2937; border: 1px solid #374151; color: var(--text-muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }

    .container { max-width: 1200px; margin: 20px auto; padding: 0 16px; display: flex; flex-direction: column; gap: 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card {
      background: var(--card); border: 1px solid var(--card-border);
      border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 14px;
    }
    .card-title {
      font-size: 13px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--text-muted); display: flex; align-items: center; justify-content: space-between;
    }
    
    .vitals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .vital-box {
      background: rgba(9, 13, 22, 0.7); border: 1px solid var(--card-border);
      padding: 12px; border-radius: 8px;
    }
    .vital-header { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 6px; }
    .hearts-row, .food-row { display: flex; gap: 3px; font-size: 13px; }
    .xp-bar-bg { width: 100%; height: 8px; background: #000; border-radius: 4px; overflow: hidden; margin-top: 4px; }
    .xp-bar-fill { height: 100%; background: linear-gradient(90deg, #10b981, #84cc16); width: 0%; transition: width 0.3s; }

    .coords-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-family: monospace; font-size: 12px; }
    .coord-item { background: rgba(9, 13, 22, 0.7); border: 1px solid var(--card-border); padding: 8px; border-radius: 6px; }
    .coord-label { font-size: 10px; color: var(--text-muted); display: block; }
    .coord-val { font-size: 13px; font-weight: 700; color: #fff; }

    .btn-row { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      background: #1f2937; border: 1px solid #374151; color: var(--text);
      padding: 7px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
    }
    button:hover { background: #374151; border-color: #4b5563; }
    button:active { transform: translateY(1px); }
    .btn-primary { background: #059669; border-color: #10b981; color: #fff; }
    .btn-primary:hover { background: #10b981; }

    .chat-container { height: 320px; display: flex; flex-direction: column; }
    .chat-box {
      flex: 1; background: #070b12; border: 1px solid var(--card-border);
      border-radius: 8px; padding: 10px; overflow-y: auto; font-family: monospace; font-size: 12px;
      display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;
    }
    .chat-msg { line-height: 1.4; word-break: break-word; }
    .chat-time { color: #64748b; font-size: 10px; margin-right: 6px; }
    .chat-sender { font-weight: 700; color: #fbbf24; margin-right: 4px; }
    .chat-sender.bot { color: #34d399; }
    .chat-sender.server { color: #818cf8; }
    .chat-input-row { display: flex; gap: 8px; }
    input[type="text"], input[type="number"] {
      background: #070b12; border: 1px solid #374151; color: #fff;
      padding: 8px 12px; border-radius: 6px; font-size: 12px; font-family: monospace;
    }
    input[type="text"]:focus, input[type="number"]:focus { outline: none; border-color: #10b981; }

    .log-box {
      height: 200px; background: #070b12; border: 1px solid var(--card-border);
      border-radius: 8px; padding: 10px; overflow-y: auto; font-family: monospace; font-size: 11px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .log-entry { line-height: 1.4; color: #cbd5e1; }
    .log-info { color: #94a3b8; }
    .log-success { color: #34d399; }
    .log-warn { color: #fbbf24; }
    .log-error { color: #f87171; }

    .banner-warning {
      background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4);
      color: #fef08a; padding: 12px 16px; border-radius: 8px; font-size: 13px;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .banner-warning a { color: #fff; font-weight: 700; text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">⚔️</div>
      <div>
        <h1>Minecraft AFK Bot — Live Dashboard</h1>
        <p><span id="header-host">alamincraft.aternos.me:26832</span> &bull; Uptime: <span id="header-uptime">00:00:00</span></p>
      </div>
    </div>
    <div class="brand">
      <div id="status-badge" class="status-badge badge-offline">
        <span class="dot"></span>
        <span id="status-text">OFFLINE</span>
      </div>
      <button class="btn-primary" onclick="reconnectNow()">⚡ Reconnect Now</button>
    </div>
  </header>

  <div class="container">
    <div id="aternos-banner" class="banner-warning" style="display: none;">
      <div>
        ⚠️ <strong>Server is in Standby:</strong> Aternos powers down empty servers.
        Visit <a href="https://aternos.org/servers/" target="_blank">aternos.org</a> and click <strong>Start</strong>. The bot will automatically join!
      </div>
      <button onclick="pingServer()">Check Status</button>
    </div>

    <!-- Server IP, Port & Bot Name Settings -->
    <div class="card">
      <div class="card-title">
        <span>⚙️ Server IP, Port &amp; Bot Name Settings</span>
        <span id="config-status" style="font-size: 11px; color: #34d399;">Active: <strong id="cfg-active-target">alamincraft.aternos.me:26832</strong></span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
        <div>
          <label style="font-size: 11px; color: #94a3b8; display: block; margin-bottom: 4px;">Server IP / Host:</label>
          <input type="text" id="cfg-host" value="alamincraft.aternos.me" placeholder="alamincraft.aternos.me" style="width: 100%;">
        </div>
        <div>
          <label style="font-size: 11px; color: #94a3b8; display: block; margin-bottom: 4px;">Server Port:</label>
          <input type="number" id="cfg-port" value="26832" placeholder="26832" style="width: 100%;">
        </div>
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <label style="font-size: 11px; color: #94a3b8;">Bot In-Game Name:</label>
            <a href="javascript:void(0)" onclick="generateRandomName()" style="font-size: 10px; color: #34d399; text-decoration: none;">🎲 Random Name</a>
          </div>
          <input type="text" id="cfg-username" value="AFK_Bot_Pro" placeholder="AFK_Bot_Pro" style="width: 100%;">
        </div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; margin-top: 4px;">
        <button onclick="saveAndConnect()" class="btn-primary">💾 Connect &amp; Save Settings</button>
        <button onclick="disconnectBot()" style="background: #991b1b; border-color: #ef4444; color: #fff;">🛑 Disconnect</button>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="card">
      <div class="card-title">
        <span>🎮 Manual Bot Actions</span>
        <span style="font-size: 11px; color: #64748b;">Controls trigger in-game immediately</span>
      </div>
      <div class="btn-row">
        <button onclick="doAction('jump')">🦘 Jump</button>
        <button onclick="doAction('swing')">🗡️ Swing Arm</button>
        <button onclick="doAction('rotate')">👀 Look Around</button>
        <button onclick="doAction('sneak')">🧎 Sneak / Stand</button>
        <button onclick="doAction('step')">👟 Step Forward/Back</button>
        <button onclick="doAction('eat')">🥩 Eat Food</button>
        <button onclick="doAction('respawn')">✨ Respawn</button>
      </div>
    </div>

    <!-- Vitals & Telemetry -->
    <div class="grid">
      <div class="card">
        <div class="card-title">
          <span>❤️ Vitals & Telemetry</span>
          <span id="ping-text" style="font-family: monospace; font-size: 11px;">Ping: --ms</span>
        </div>
        <div class="vitals-grid">
          <div class="vital-box">
            <div class="vital-header">
              <span style="color: #f87171; font-weight: 700;">Health</span>
              <span id="health-val" style="font-family: monospace;">20 / 20 HP</span>
            </div>
            <div id="hearts-row" class="hearts-row">❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️</div>
          </div>
          <div class="vital-box">
            <div class="vital-header">
              <span style="color: #fbbf24; font-weight: 700;">Food</span>
              <span id="food-val" style="font-family: monospace;">20 / 20</span>
            </div>
            <div id="food-row" class="food-row">🍗🍗🍗🍗🍗🍗🍗🍗🍗🍗</div>
          </div>
        </div>

        <div class="vital-box">
          <div class="vital-header">
            <span style="color: #34d399; font-weight: 700;">XP Level <span id="xp-level">0</span></span>
            <span id="xp-progress">0%</span>
          </div>
          <div class="xp-bar-bg">
            <div id="xp-bar-fill" class="xp-bar-fill"></div>
          </div>
        </div>

        <div class="coords-grid">
          <div class="coord-item"><span class="coord-label">X</span><span id="pos-x" class="coord-val">--</span></div>
          <div class="coord-item"><span class="coord-label">Y</span><span id="pos-y" class="coord-val">--</span></div>
          <div class="coord-item"><span class="coord-label">Z</span><span id="pos-z" class="coord-val">--</span></div>
          <div class="coord-item"><span class="coord-label">Facing</span><span id="pos-yaw" class="coord-val">--</span></div>
        </div>
      </div>

      <!-- In-Game Chat -->
      <div class="card">
        <div class="card-title">
          <span>💬 In-Game Live Chat</span>
          <span style="font-size: 11px; color: #64748b;">Real-Time Feed</span>
        </div>
        <div class="chat-container">
          <div id="chat-box" class="chat-box">
            <div style="color: #64748b; text-align: center; margin-top: 100px;">Waiting for server chat...</div>
          </div>
          <div class="chat-input-row">
            <input type="text" id="chat-input" placeholder="Type message or /command (e.g. /help, /spawn)..." onkeydown="if(event.key==='Enter')sendChat()">
            <button class="btn-primary" onclick="sendChat()">Send</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Players & Logs -->
    <div class="grid">
      <div class="card">
        <div class="card-title">
          <span>👥 Online Players (<span id="player-count">0</span>)</span>
        </div>
        <div id="players-list" style="display: flex; flex-wrap: wrap; gap: 6px; min-height: 40px; font-family: monospace; font-size: 12px;">
          <span style="color: #64748b;">No players detected</span>
        </div>

        <div class="card-title" style="margin-top: 10px;">
          <span>🎒 Inventory</span>
        </div>
        <div id="inventory-list" style="display: flex; flex-wrap: wrap; gap: 6px; font-family: monospace; font-size: 11px;">
          <span style="color: #64748b;">Empty</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>📜 Bot Activity Logs</span>
          <button onclick="clearLogs()" style="font-size: 10px; padding: 2px 8px;">Clear</button>
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

    function renderStatus(data) {
      if (!data) return;
      const isOnline = data.state === 'online';
      const badge = document.getElementById('status-badge');
      const text = document.getElementById('status-text');

      badge.className = 'status-badge ' + (
        isOnline ? 'badge-online' :
        data.state === 'reconnecting' ? 'badge-reconnecting' :
        data.state === 'error' ? 'badge-error' : 'badge-offline'
      );

      text.innerText = isOnline ? 'ONLINE' :
        data.state === 'reconnecting' ? ('RECONNECTING (' + (data.reconnectCountdown||0) + 's)') :
        data.state === 'connecting' ? 'CONNECTING...' :
        data.state === 'error' ? 'ERROR / STANDBY' : 'OFFLINE';

      document.getElementById('header-uptime').innerText = formatTime(data.uptime || 0);
      document.getElementById('ping-text').innerText = 'Ping: ' + (data.ping || 0) + 'ms';

      const isStandby = data.errorMessage && (data.errorMessage.includes('standby') || data.errorMessage.includes('-1'));
      document.getElementById('aternos-banner').style.display = isStandby ? 'flex' : 'none';

      const hp = data.health || 20;
      document.getElementById('health-val').innerText = Math.round(hp) + ' / 20 HP';
      const heartsCount = Math.round(hp / 2);
      document.getElementById('hearts-row').innerText = '❤️'.repeat(heartsCount) + '🖤'.repeat(10 - heartsCount);

      const food = data.food || 20;
      document.getElementById('food-val').innerText = Math.round(food) + ' / 20';
      const foodCount = Math.round(food / 2);
      document.getElementById('food-row').innerText = '🍗'.repeat(foodCount) + '🦴'.repeat(10 - foodCount);

      document.getElementById('xp-level').innerText = data.xp?.level || 0;
      document.getElementById('xp-progress').innerText = (data.xp?.progress || 0) + '%';
      document.getElementById('xp-bar-fill').style.width = (data.xp?.progress || 0) + '%';

      document.getElementById('pos-x').innerText = data.position?.x ?? '--';
      document.getElementById('pos-y').innerText = data.position?.y ?? '--';
      document.getElementById('pos-z').innerText = data.position?.z ?? '--';
      document.getElementById('pos-yaw').innerText = (data.position?.yaw ?? '--') + '°';

      const pl = data.players || [];
      document.getElementById('player-count').innerText = pl.length;
      const plEl = document.getElementById('players-list');
      if (pl.length > 0) {
        plEl.innerHTML = pl.map(p => '<span style="background: #1e293b; padding: 3px 8px; border-radius: 4px; color: #38bdf8;">' + p + '</span>').join('');
      } else {
        plEl.innerHTML = '<span style="color: #64748b;">No players online</span>';
      }

      const inv = data.inventory || [];
      const invEl = document.getElementById('inventory-list');
      if (inv.length > 0) {
        invEl.innerHTML = inv.map(i => '<span style="background: #1e293b; padding: 2px 6px; border-radius: 4px;">' + i.name + (i.count > 1 ? ' x' + i.count : '') + '</span>').join('');
      } else {
        invEl.innerHTML = '<span style="color: #64748b;">Empty</span>';
      }

      if (!hasLoadedConfig && data.config) {
        document.getElementById('cfg-host').value = data.config.host || 'alamincraft.aternos.me';
        document.getElementById('cfg-port').value = data.config.port || 26832;
        document.getElementById('cfg-username').value = data.config.username || 'AFK_Bot_Pro';
        hasLoadedConfig = true;
      }
      if (data.config) {
        document.getElementById('header-host').innerText = data.config.host + ':' + data.config.port;
        document.getElementById('cfg-active-target').innerText = data.config.host + ':' + data.config.port + ' (' + data.config.username + ')';
      }
    }

    function addChatMsg(msg) {
      const box = document.getElementById('chat-box');
      const el = document.createElement('div');
      el.className = 'chat-msg';
      const senderClass = msg.isSystem ? 'server' : (msg.sender === CONFIG.username ? 'bot' : '');
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

    let hasLoadedConfig = false;

    function generateRandomName() {
      const names = ['Miner', 'Steve', 'Alex', 'Shadow', 'Ghost', 'Pro', 'Craft', 'Legend', 'Ninja', 'Titan'];
      const num = Math.floor(100 + Math.random() * 900);
      document.getElementById('cfg-username').value = names[Math.floor(Math.random() * names.length)] + '_AFK_' + num;
    }

    function saveAndConnect() {
      const host = document.getElementById('cfg-host').value.trim();
      const port = Number(document.getElementById('cfg-port').value);
      const username = document.getElementById('cfg-username').value.trim();
      if (!host || !port || !username) return alert('Please enter Server IP, Port and Bot Username!');

      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, username })
      }).then(r => r.json()).then(res => {
        alert('Saved! Connecting bot to ' + host + ':' + port + ' as ' + username + '...');
      });
    }

    function disconnectBot() {
      fetch('/api/disconnect', { method: 'POST' }).then(() => {
        alert('Bot disconnected.');
      });
    }

    function pingServer() {
      fetch('/api/ping', { method: 'POST' })
        .then(r => r.json())
        .then(res => {
          alert(res.online ? 'Server is ONLINE! Latency: ' + res.latency + 'ms' : 'Server is OFFLINE: ' + (res.error || 'Check aternos.org'));
        });
    }

    const ev = new EventSource('/api/events');
    ev.addEventListener('status', e => renderStatus(JSON.parse(e.data)));
    ev.addEventListener('chat', e => addChatMsg(JSON.parse(e.data)));
    ev.addEventListener('log', e => addLogMsg(JSON.parse(e.data)));

    setInterval(() => {
      fetch('/api/status').then(r => r.json()).then(renderStatus).catch(() => {});
    }, 2500);

    fetch('/api/status').then(r => r.json()).then(renderStatus);
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.push(res);
    res.write(`event: status\ndata: ${JSON.stringify(getBotSnapshot())}\n\n`);

    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) sseClients.splice(idx, 1);
    });
    return;
  }

  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getBotSnapshot()));
  }

  if (req.url === '/api/ping' && req.method === 'POST') {
    isServerOnline().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // Reconnect API
  if (req.url === '/api/reconnect' && req.method === 'POST') {
    connectBot();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Update IP, Port, Username Config API
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { host, port, username } = JSON.parse(body);
        if (host) CONFIG.host = host.trim();
        if (port) CONFIG.port = Number(port);
        if (username) CONFIG.username = username.trim();
        addLog('info', `Settings updated: ${CONFIG.host}:${CONFIG.port} with bot name "${CONFIG.username}"`);
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
  if (req.url === '/api/disconnect' && req.method === 'POST') {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectCountdownInterval) clearInterval(reconnectCountdownInterval);
    if (antiAfkInterval) clearInterval(antiAfkInterval);
    if (bot) {
      try { bot.quit(); } catch {}
      bot = null;
    }
    botStatus = 'offline';
    connectedAt = null;
    addLog('info', 'User requested bot disconnection.');
    broadcastSSE('status', getBotSnapshot());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // Chat API
  if (req.url === '/api/chat' && req.method === 'POST') {
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
          res.end(JSON.stringify({ error: 'Bot not online' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid body' }));
      }
    });
    return;
  }

  // Action API
  if (req.url === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { action } = JSON.parse(body);
        if (bot && botStatus === 'online') {
          if (action === 'jump') {
            bot.setControlState('jump', true);
            setTimeout(() => bot && bot.setControlState('jump', false), 350);
            addLog('info', 'Manual Jump');
          } else if (action === 'swing') {
            bot.swingArm('right');
            addLog('info', 'Manual Arm Swing');
          } else if (action === 'sneak') {
            const current = bot.getControlState('sneak') || false;
            bot.setControlState('sneak', !current);
            addLog('info', 'Toggled Sneak');
          } else if (action === 'rotate') {
            const yaw = (Math.random() - 0.5) * Math.PI * 2;
            const pitch = (Math.random() - 0.5) * 0.8;
            bot.look(yaw, pitch, true).catch(() => {});
            addLog('info', 'Rotated Orientation');
          } else if (action === 'step') {
            bot.setControlState('forward', true);
            setTimeout(() => {
              if (bot) {
                bot.setControlState('forward', false);
                bot.setControlState('back', true);
                setTimeout(() => bot && bot.setControlState('back', false), 250);
              }
            }, 250);
            addLog('info', 'Manual Step');
          } else if (action === 'eat') {
            const food = bot.inventory?.items().find(i => 
              ['bread', 'beef', 'steak', 'porkchop', 'carrot', 'apple', 'baked_potato'].some(k => i.name.includes(k))
            );
            if (food) {
              bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
              addLog('info', 'Manual Eat');
            }
          } else if (action === 'respawn') {
            bot.respawn();
            addLog('info', 'Manual Respawn');
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

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DASHBOARD_HTML);
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(`🚀 Minecraft AFK Bot & Live Dashboard Online!`);
  console.log(`🌐 Web URL: http://0.0.0.0:${PORT}`);
  console.log(`🎮 Target Server: ${CONFIG.host}:${CONFIG.port}`);
  console.log(`==================================================`);
});
