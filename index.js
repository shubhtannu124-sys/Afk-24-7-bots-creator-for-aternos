"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const mineflayer = require("mineflayer");
const { Movements, pathfinder } = require("mineflayer-pathfinder");
const express = require("express");
const { addLog, getLogs } = require("./logger");

const SETTINGS_PATH = path.join(__dirname, "settings.json");
const config = require(SETTINGS_PATH);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT) || 5000;
const MAX_ERRORS = 25;
const MAX_BOT_LOGS = 300;
const SETTINGS_BACKUP = SETTINGS_PATH + ".bak";

const DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || "").trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"));
const sessions = new Map();
const botStates = new Map();

function keyFor(serverName, botName) {
  return `${serverName}::${botName}`;
}

function safeString(value, fallback = "") {
  return value == null ? fallback : String(value).trim();
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function getNow() {
  return new Date().toISOString();
}

function appendStateLog(state, message, level = "info") {
  const line = `[${getNow()}] ${message}`;
  state.logs.push({ time: Date.now(), level, message: line });
  if (state.logs.length > MAX_BOT_LOGS) state.logs.splice(0, state.logs.length - MAX_BOT_LOGS);
  try { addLog(line); } catch (_) {}
  console.log(line);
}

function rememberError(state, error) {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  state.errors.push({ time: Date.now(), message: String(message).slice(0, 2000) });
  if (state.errors.length > MAX_ERRORS) state.errors.splice(0, state.errors.length - MAX_ERRORS);
  appendStateLog(state, `ERROR ${String(message).split("\n")[0]}`, "error");
}

function touch(state) {
  state.lastActivity = Date.now();
}

function getUptime(state) {
  if (!state.connected || !state.startTime) return 0;
  return Math.max(0, Math.floor((Date.now() - state.startTime) / 1000));
}

function normalizeConfig() {
  if (!Array.isArray(config.servers)) config.servers = [];
  if (!config.utils) config.utils = {};
  if (!config.movement) config.movement = {};
  if (!config.modules) config.modules = {};
  if (!config.combat) config.combat = {};
  if (!config.discord) config.discord = { enabled: false, webhookUrl: "", events: {} };
  if (!config.chat) config.chat = { respond: true };
  if (!config.performance) config.performance = {};
  config.performance.viewDistance = Number(config.performance.viewDistance) || 2;
  if (typeof config.performance.physicsEnabled !== "boolean") config.performance.physicsEnabled = false;
  if (!Number(config.performance.connectTimeout)) config.performance.connectTimeout = 30000;
  if (!Number(config.performance.checkTimeoutInterval)) config.performance.checkTimeoutInterval = 30000;
  return config;
}

normalizeConfig();

function validateServerInput(input) {
  const name = safeString(input.name);
  const ip = safeString(input.ip);
  const port = Number(input.port || 25565);
  const version = safeString(input.version);
  const auth = safeString(input.auth || "offline").toLowerCase();

  if (!name || name.length > 60) throw new Error("Server name must be 1-60 characters.");
  if (!ip || ip.length > 253 || /[\r\n]/.test(ip)) throw new Error("Invalid server address.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535.");
  if (auth !== "offline" && auth !== "microsoft") throw new Error("Auth must be offline or microsoft.");

  return { name, ip, port, version: version || undefined, auth };
}

function validateBotName(name) {
  const value = safeString(name);
  if (!value || value.length > 16) throw new Error("Bot name must be 1-16 characters.");
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error("Bot name can contain only letters, numbers and underscore.");
  return value;
}

function saveConfigAtomic() {
  const payload = JSON.stringify(config, null, 2) + "\n";
  const tempPath = SETTINGS_PATH + ".tmp";
  fs.writeFileSync(tempPath, payload, "utf8");
  if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, SETTINGS_BACKUP);
  fs.renameSync(tempPath, SETTINGS_PATH);
}

function getServerConfig(serverName) {
  return config.servers.find(server => String(server.name) === String(serverName)) || null;
}

function findState(serverName, botName) {
  if (serverName && botName) return botStates.get(keyFor(serverName, botName)) || null;
  if (botName) {
    const matches = [...botStates.values()].filter(state => state.botName === botName);
    return matches.length === 1 ? matches[0] : null;
  }
  return null;
}

function createState(server, botName) {
  const serverName = String(server.name);
  return {
    key: keyFor(serverName, botName),
    serverName,
    host: String(server.ip),
    port: Number(server.port) || 25565,
    version: server.version || undefined,
    auth: server.auth || "offline",
    botName,
    bot: null,
    movements: null,
    connected: false,
    connecting: false,
    manualStop: false,
    generation: 0,
    reconnectTimer: null,
    reconnectAttempts: 0,
    movementTimer: null,
    lookTimer: null,
    jumpTimer: null,
    chatTimer: null,
    combatTimer: null,
    authTimer: null,
    startTime: 0,
    lastActivity: Date.now(),
    errors: [],
    logs: [],
    eating: false
  };
}

function rebuildStatesFromConfig() {
  botStates.clear();
  const seenServers = new Set();
  for (const server of config.servers) {
    if (!server || !server.name || !server.ip) throw new Error("Every server needs name and ip.");
    if (seenServers.has(String(server.name))) throw new Error(`Duplicate server name: ${server.name}`);
    seenServers.add(String(server.name));
    if (!Array.isArray(server.bots) || server.bots.length === 0) throw new Error(`Server ${server.name} needs at least one bot.`);

    const uniqueBots = [];
    const seenBots = new Set();
    for (const rawName of server.bots) {
      const botName = validateBotName(rawName);
      if (seenBots.has(botName)) continue;
      seenBots.add(botName);
      uniqueBots.push(botName);
      const state = createState({ ...server, name: String(server.name) }, botName);
      if (botStates.has(state.key)) throw new Error(`Duplicate bot connection: ${state.key}`);
      botStates.set(state.key, state);
    }
    server.bots = uniqueBots;
  }
}

if (config.servers.length === 0) {
  config.servers.push({ name: "Minecraft", ip: "127.0.0.1", port: 25565, version: "1.20.1", auth: "offline", bots: ["Bot"] });
}
rebuildStatesFromConfig();

function sendDiscord(state, event, message) {
  try {
    if (!config.discord?.enabled) return;
    if (!config.discord?.events?.[event]) return;
    if (!config.discord?.webhookUrl) return;

    const url = new URL(config.discord.webhookUrl);
    if (url.protocol !== "https:") return;
    const body = JSON.stringify({ content: `[${state.serverName}] [${state.botName}] ${message}` });

    const request = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      timeout: 5000
    }, response => response.resume());
    request.on("error", () => {});
    request.write(body);
    request.end();
  } catch (_) {}
}

function clearReconnect(state) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function reconnectDelay(state) {
  const base = Math.max(1000, Number(config.utils?.["auto-reconnect-delay"]) || 2000);
  const max = Math.max(base, Number(config.utils?.["max-reconnect-delay"]) || 120000);
  return Math.min(max, base * Math.pow(2, Math.min(state.reconnectAttempts, 6)));
}

function scheduleReconnect(state, reason = "") {
  if (!config.utils?.["auto-reconnect"]) return;
  if (state.manualStop || state.reconnectTimer || state.connecting || state.bot) return;

  const delay = reconnectDelay(state);
  state.reconnectAttempts += 1;
  appendStateLog(state, `Reconnect scheduled in ${Math.ceil(delay / 1000)}s${reason ? ` (${reason})` : ""}`, "warn");

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    startBot(state).catch(error => {
      rememberError(state, error);
      scheduleReconnect(state, "retry failed");
    });
  }, delay);
  state.reconnectTimer.unref?.();
}

function stopMovement(state) {
  if (state.movementTimer) clearTimeout(state.movementTimer);
  state.movementTimer = null;
  if (state.bot) {
    try { state.bot.clearControlStates(); } catch (_) {}
  }
}

function startCircleWalk(state) {
  stopMovement(state);
  const settings = config.movement?.["circle-walk"];
  if (!config.movement?.enabled || !settings?.enabled || !config.utils?.["anti-afk"]?.enabled) return;

  const stepBlocks = Math.max(1, Number(settings["step-blocks"]) || 2);
  const maxStepTime = Math.max(1000, Number(settings["max-step-time"]) || 4000);
  const turnPause = Math.max(50, Number(settings["turn-pause"]) || 150);
  const direction = String(settings.turn || "right").toLowerCase() === "left" ? -1 : 1;

  function segment() {
    if (!state.bot || !state.connected || state.manualStop) return;
    const bot = state.bot;
    const startPos = bot.entity?.position;
    if (!startPos) return;

    const startX = Number(startPos.x);
    const startZ = Number(startPos.z);
    const startedAt = Date.now();
    try { bot.setControlState("forward", true); } catch (_) { return; }

    const tick = () => {
      if (!state.bot || state.bot !== bot || !state.connected || state.manualStop) {
        stopMovement(state);
        return;
      }
      const pos = bot.entity?.position;
      const dist = pos ? Math.hypot(Number(pos.x) - startX, Number(pos.z) - startZ) : 0;
      if (dist >= stepBlocks || Date.now() - startedAt >= maxStepTime) {
        try { bot.setControlState("forward", false); } catch (_) {}
        const yaw = Number(bot.entity?.yaw) || 0;
        bot.look(yaw + direction * Math.PI / 2, 0, true).catch(() => {});
        state.movementTimer = setTimeout(segment, turnPause);
        state.movementTimer.unref?.();
        touch(state);
        return;
      }
      state.movementTimer = setTimeout(tick, 100);
      state.movementTimer.unref?.();
    };
    tick();
  }

  segment();
}

function startLookAround(state) {
  if (state.lookTimer) clearInterval(state.lookTimer);
  if (!config.movement?.["look-around"]?.enabled) return;
  const interval = Math.max(1000, Number(config.movement["look-around"].interval) || 5000);
  state.lookTimer = setInterval(() => {
    if (!state.bot || !state.connected || !state.bot.entity) return;
    try {
      const yaw = Number(state.bot.entity.yaw) || 0;
      state.bot.look(yaw + (Math.random() - 0.5) * Math.PI, 0, false).catch(() => {});
      touch(state);
    } catch (_) {}
  }, interval);
  state.lookTimer.unref?.();
}

function startRandomJump(state) {
  if (state.jumpTimer) clearInterval(state.jumpTimer);
  if (!config.movement?.["random-jump"]?.enabled) return;
  const interval = Math.max(2000, Number(config.movement["random-jump"].interval) || 10000);
  state.jumpTimer = setInterval(() => {
    if (!state.bot || !state.connected) return;
    try {
      state.bot.setControlState("jump", true);
      setTimeout(() => {
        if (state.bot) {
          try { state.bot.setControlState("jump", false); } catch (_) {}
        }
      }, 150).unref?.();
    } catch (_) {}
  }, interval);
  state.jumpTimer.unref?.();
}

function runAutoAuth(state) {
  if (state.authTimer) clearTimeout(state.authTimer);
  if (!config.utils?.["auto-auth"]?.enabled) return;
  const password = safeString(config.utils["auto-auth"].password);
  if (!password) return;

  state.authTimer = setTimeout(() => {
    state.authTimer = null;
    if (!state.bot || !state.connected) return;
    try {
      state.bot.chat(`/login ${password}`);
      touch(state);
      appendStateLog(state, "Auto-auth command sent.", "control");
    } catch (error) { rememberError(state, error); }
  }, 2000);
  state.authTimer.unref?.();
}

function startChatMessages(state) {
  if (state.chatTimer) clearInterval(state.chatTimer);
  const settings = config.utils?.["chat-messages"];
  if (!settings?.enabled || !settings?.repeat || !Array.isArray(settings.messages) || !settings.messages.length) return;
  const interval = Math.max(1000, (Number(settings["repeat-delay"]) || 120) * 1000);
  state.chatTimer = setInterval(() => {
    if (!state.bot || !state.connected) return;
    try {
      const msg = String(settings.messages[Math.floor(Math.random() * settings.messages.length)] || "").slice(0, 256);
      if (msg) state.bot.chat(msg);
      touch(state);
    } catch (error) { rememberError(state, error); }
  }, interval);
  state.chatTimer.unref?.();
}

const hostileMobs = new Set([
  "zombie", "skeleton", "spider", "creeper", "witch", "enderman", "drowned",
  "husk", "stray", "pillager", "vindicator", "ravager", "phantom", "silverfish", "cave_spider"
]);
const foods = new Set([
  "bread", "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton", "cooked_rabbit",
  "cooked_cod", "cooked_salmon", "baked_potato", "carrot", "golden_carrot", "apple", "melon_slice",
  "sweet_berries", "glow_berries", "beetroot", "potato", "pumpkin_pie", "cookie"
]);

async function tryEat(state) {
  if (state.eating || !state.bot || !state.connected) return;
  if (!config.combat?.["auto-eat"] || Number(state.bot.food) > 12) return;
  const food = state.bot.inventory.items().find(item => foods.has(item.name));
  if (!food) return;

  state.eating = true;
  try {
    await state.bot.equip(food, "hand");
    await state.bot.consume();
    appendStateLog(state, `Ate ${food.name}.`, "control");
    touch(state);
  } catch (error) { rememberError(state, error); }
  finally { state.eating = false; }
}

function startCombat(state) {
  if (state.combatTimer) clearInterval(state.combatTimer);
  if (!config.modules?.combat || !config.combat?.["attack-mobs"]) return;
  const interval = Math.max(250, Number(config.combat["attack-delay"]) || 1000);
  const range = Number(config.combat["attack-range"]) || 3.5;

  state.combatTimer = setInterval(() => {
    if (!state.bot || !state.connected || !state.bot.entity) return;
    try {
      const target = state.bot.nearestEntity(entity => {
        if (!entity || entity.type !== "mob" || !entity.position) return false;
        if (!hostileMobs.has(String(entity.name || "").toLowerCase())) return false;
        return state.bot.entity.position.distanceTo(entity.position) <= range;
      });
      if (target) {
        state.bot.attack(target);
        touch(state);
      }
    } catch (error) { rememberError(state, error); }
    tryEat(state).catch(error => rememberError(state, error));
  }, interval);
  state.combatTimer.unref?.();
}

function handleChat(state, username, message) {
  const text = String(message);
  if (config.utils?.["chat-log"]) appendStateLog(state, `<${username}> ${text}`, "chat");
  if (config.discord?.events?.chat) sendDiscord(state, "chat", `<${username}> ${text}`);
  if (!config.chat?.respond || username === state.botName) return;

  const lower = text.trim().toLowerCase();
  if (lower === "hi" || lower === "hello" || lower === "hey") {
    try { state.bot.chat(`Hello ${username}!`); } catch (_) {}
  }
}

function cleanupBot(state, reason = "cleanup") {
  stopMovement(state);
  for (const field of ["lookTimer", "jumpTimer", "chatTimer", "combatTimer"]) {
    if (state[field]) clearInterval(state[field]);
    state[field] = null;
  }
  if (state.authTimer) clearTimeout(state.authTimer);
  state.authTimer = null;

  const oldBot = state.bot;
  state.bot = null;
  state.movements = null;
  state.connected = false;
  state.eating = false;

  if (oldBot) {
    try { oldBot.clearControlStates(); } catch (_) {}
    try { oldBot.quit(reason); } catch (_) {}
    try { oldBot._client?.socket?.destroy(); } catch (_) {}
  }
}

function registerBotEvents(state, bot, generation) {
  bot.on("login", () => {
    if (generation !== state.generation) return;
    touch(state);
    appendStateLog(state, "Logged in.", "success");
  });

  bot.once("spawn", () => {
    if (generation !== state.generation || bot !== state.bot) return;
    state.connected = true;
    state.reconnectAttempts = 0;
    state.startTime = Date.now();
    touch(state);

    try {
      state.movements = new Movements(bot);
      state.movements.canDig = false;
      state.movements.allow1by1towers = false;
      state.movements.allowFreeMotion = false;
      bot.pathfinder.setMovements(state.movements);
    } catch (error) {
      rememberError(state, error);
    }

    startCircleWalk(state);
    if (config.utils?.["anti-afk"]?.sneak) {
      try { bot.setControlState("sneak", true); } catch (_) {}
    }
    startLookAround(state);
    startRandomJump(state);
    startChatMessages(state);
    startCombat(state);
    runAutoAuth(state);

    appendStateLog(state, `Connected to ${state.host}:${state.port}.`, "success");
    sendDiscord(state, "connect", "Connected.");
  });

  bot.on("chat", (username, message) => {
    if (generation !== state.generation) return;
    touch(state);
    handleChat(state, username, message);
  });

  bot.on("whisper", (username, message) => {
    if (generation !== state.generation) return;
    appendStateLog(state, `[WHISPER] <${username}> ${message}`, "chat");
    touch(state);
  });

  bot.on("kicked", reason => {
    if (generation !== state.generation) return;
    let text = String(reason);
    try { if (typeof reason !== "string") text = JSON.stringify(reason); } catch (_) {}
    state.connected = false;
    appendStateLog(state, `Kicked: ${text}`, "warn");
    sendDiscord(state, "disconnect", `Kicked: ${text}`);
  });

  bot.on("error", error => {
    if (generation !== state.generation) return;
    rememberError(state, error);
  });

  bot.on("end", reason => {
    if (generation !== state.generation) return;
    cleanupBot(state, "connection ended");
    appendStateLog(state, `Connection ended${reason ? `: ${reason}` : ""}`, "warn");
    sendDiscord(state, "disconnect", "Disconnected.");
    scheduleReconnect(state, "connection ended");
  });
}

async function startBot(state) {
  if (state.connecting || state.bot) return false;
  state.manualStop = false;
  clearReconnect(state);
  state.connecting = true;
  const generation = ++state.generation;

  try {
    appendStateLog(state, `Connecting to ${state.host}:${state.port}...`, "control");
    const options = {
      host: state.host,
      port: state.port,
      username: state.botName,
      auth: state.auth,
      viewDistance: Number(config.performance?.viewDistance) || 2,
      physicsEnabled: config.performance?.physicsEnabled === true,
      chatLog: false,
      connectTimeout: Number(config.performance?.connectTimeout) || 30000,
      checkTimeoutInterval: Number(config.performance?.checkTimeoutInterval) || 30000,
      hideErrors: false
    };
    if (state.version) options.version = state.version;

    const bot = mineflayer.createBot(options);
    state.bot = bot;
    bot.loadPlugin(pathfinder);
    registerBotEvents(state, bot, generation);
    return true;
  } catch (error) {
    state.bot = null;
    rememberError(state, error);
    scheduleReconnect(state, "bot creation failed");
    return false;
  } finally {
    state.connecting = false;
  }
}

async function stopBot(state, reason = "dashboard stop") {
  state.manualStop = true;
  clearReconnect(state);
  state.generation += 1;
  cleanupBot(state, reason);
  state.reconnectAttempts = 0;
  appendStateLog(state, "Stopped from dashboard.", "control");
}

function authenticate(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const token = req.headers["x-dashboard-token"] || req.cookies?.dashboard_session;
  if (token && sessions.has(token) && sessions.get(token) > Date.now()) return next();
  return res.status(401).json({ success: false, msg: "Dashboard authentication required." });
}

// Tiny cookie parser without another dependency.
app.use((req, _res, next) => {
  const cookieHeader = String(req.headers.cookie || "");
  req.cookies = {};
  for (const piece of cookieHeader.split(";")) {
    const [k, ...rest] = piece.trim().split("=");
    if (k) req.cookies[k] = rest.join("=");
  }
  next();
});

app.post("/api/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.json({ success: true, disabled: true });
  const password = String(req.body?.password || "");
  if (password !== DASHBOARD_PASSWORD) return res.status(401).json({ success: false, msg: "Incorrect password." });
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  res.setHeader("Set-Cookie", `dashboard_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ success: true });
});

app.get("/api/auth", (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.json({ required: false, authenticated: true });
  const token = req.cookies?.dashboard_session;
  const authenticated = !!(token && sessions.has(token) && sessions.get(token) > Date.now());
  res.json({ required: true, authenticated });
});

function statePayload(state) {
  const pos = state.bot?.entity?.position;
  return {
    key: state.key,
    server: state.serverName,
    bot: state.botName,
    host: state.host,
    port: state.port,
    version: state.version || "auto",
    auth: state.auth,
    status: state.connected ? "connected" : state.connecting ? "connecting" : "offline",
    uptime: getUptime(state),
    coords: pos ? { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) } : null,
    reconnectAttempts: state.reconnectAttempts,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    lastActivity: state.lastActivity,
    errors: state.errors.slice(-10)
  };
}

function apiProtection(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  return authenticate(req, res, next);
}

app.get("/api/state", apiProtection, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    now: Date.now(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    servers: config.servers.map(server => ({
      name: server.name,
      ip: server.ip,
      port: server.port,
      version: server.version || "auto",
      auth: server.auth || "offline",
      bots: Array.isArray(server.bots) ? server.bots : []
    })),
    bots: [...botStates.values()].map(statePayload)
  });
});

app.get("/api/logs", apiProtection, (req, res) => {
  const state = findState(req.query.server, req.query.bot);
  if (!state) return res.status(404).json({ success: false, msg: "Bot not found." });
  res.json({ success: true, logs: state.logs.slice(-250) });
});

app.post("/api/control", apiProtection, async (req, res) => {
  const state = findState(req.body?.server, req.body?.bot);
  if (!state) return res.status(404).json({ success: false, msg: "Bot not found." });
  const action = safeString(req.body?.action).toLowerCase();

  try {
    if (action === "start") {
      await startBot(state);
      return res.json({ success: true, msg: `${state.botName} start requested.` });
    }
    if (action === "stop") {
      await stopBot(state);
      return res.json({ success: true, msg: `${state.botName} stopped.` });
    }
    if (action === "restart") {
      await stopBot(state, "restart");
      setTimeout(() => startBot(state).catch(error => rememberError(state, error)), 500);
      return res.json({ success: true, msg: `${state.botName} restart requested.` });
    }
    return res.status(400).json({ success: false, msg: "Unknown action." });
  } catch (error) {
    rememberError(state, error);
    return res.status(500).json({ success: false, msg: error.message || "Control action failed." });
  }
});

app.post("/api/control-all", apiProtection, async (req, res) => {
  const action = safeString(req.body?.action).toLowerCase();
  if (!["start", "stop", "restart"].includes(action)) return res.status(400).json({ success: false, msg: "Unknown action." });

  for (const state of botStates.values()) {
    try {
      if (action === "start") await startBot(state);
      else if (action === "stop") await stopBot(state);
      else {
        await stopBot(state, "restart all");
        setTimeout(() => startBot(state).catch(error => rememberError(state, error)), 500);
      }
    } catch (error) { rememberError(state, error); }
  }
  res.json({ success: true, msg: `${action} requested for ${botStates.size} bot(s).` });
});

function resolveCommandTarget(body) {
  const server = safeString(body.server);
  const bot = safeString(body.bot);
  const state = findState(server, bot);
  return { server, bot, state };
}

function executeConsoleCommand(state, raw) {
  const input = String(raw || "").trim();
  if (!input) return { success: false, msg: "Empty command." };

  const pieces = input.split(/\s+/);
  const command = (pieces.shift() || "").toLowerCase();
  const rest = pieces.join(" ");

  if (command === "/help") {
    return {
      success: true,
      msg: [
        "/help — command list",
        "/status — connection status and uptime",
        "/pos — current coordinates",
        "/list — players currently visible",
        "/say <message> — send chat",
        "/start — start this bot",
        "/stop — stop this bot",
        "/restart — restart this bot",
        "/raw <minecraft command> — send a server command",
        "Any other text — send as normal Minecraft chat"
      ].join("\n")
    };
  }

  if (command === "/start") {
    startBot(state).catch(error => rememberError(state, error));
    return { success: true, msg: `${state.botName} start requested.` };
  }

  if (command === "/stop") {
    stopBot(state).catch(error => rememberError(state, error));
    return { success: true, msg: `${state.botName} stopped.` };
  }

  if (command === "/restart") {
    stopBot(state, "console restart").catch(error => rememberError(state, error));
    setTimeout(() => startBot(state).catch(error => rememberError(state, error)), 500);
    return { success: true, msg: `${state.botName} restart requested.` };
  }

  if (command === "/status") {
    return {
      success: true,
      msg: `${state.serverName} / ${state.botName}\nStatus: ${state.connected ? "Connected" : state.connecting ? "Connecting" : "Offline"}\nUptime: ${formatUptime(getUptime(state))}\nReconnects: ${state.reconnectAttempts}\nRAM: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`
    };
  }

  if (command === "/pos") {
    const pos = state.bot?.entity?.position;
    if (!pos) return { success: false, msg: `${state.botName} has no position yet.` };
    return { success: true, msg: `X ${Math.floor(pos.x)}, Y ${Math.floor(pos.y)}, Z ${Math.floor(pos.z)}` };
  }

  if (command === "/list") {
    if (!state.bot) return { success: false, msg: `${state.botName} is offline.` };
    const players = Object.keys(state.bot.players || {}).filter(name => name !== state.botName);
    return { success: true, msg: players.length ? players.join(", ") : "No other players detected." };
  }

  if (!state.bot || !state.connected) return { success: false, msg: `${state.botName} is not connected.` };

  if (command === "/say") {
    if (!rest) return { success: false, msg: "Usage: /say <message>" };
    state.bot.chat(rest.slice(0, 256));
    touch(state);
    appendStateLog(state, `Console chat: ${rest.slice(0, 256)}`, "control");
    return { success: true, msg: "Message sent." };
  }

  if (command === "/raw") {
    if (!rest) return { success: false, msg: "Usage: /raw <minecraft command>" };
    const serverCommand = rest.startsWith("/") ? rest.slice(1) : rest;
    state.bot.chat(`/${serverCommand.slice(0, 255)}`);
    touch(state);
    appendStateLog(state, `Console command sent: /${serverCommand.slice(0, 255)}`, "control");
    return { success: true, msg: `Sent /${serverCommand.slice(0, 255)}` };
  }

  state.bot.chat(input.slice(0, 256));
  touch(state);
  appendStateLog(state, `Console chat: ${input.slice(0, 256)}`, "control");
  return { success: true, msg: "Chat sent." };
}

app.post("/api/command", apiProtection, (req, res) => {
  if (!config.modules?.["console-commands"]) return res.status(403).json({ success: false, msg: "Console commands are disabled." });
  const { state } = resolveCommandTarget(req.body || {});
  if (!state) return res.status(404).json({ success: false, msg: "Bot not found. Select a server and bot first." });
  try {
    const result = executeConsoleCommand(state, req.body?.command);
    if (!result.success) appendStateLog(state, `Console error: ${result.msg}`, "error");
    return res.json(result);
  } catch (error) {
    rememberError(state, error);
    return res.status(500).json({ success: false, msg: error.message || "Command failed." });
  }
});

app.post("/api/server/add", apiProtection, async (req, res) => {
  try {
    const server = validateServerInput(req.body || {});
    if (getServerConfig(server.name)) return res.status(409).json({ success: false, msg: "A server with that name already exists." });
    const bots = Array.isArray(req.body?.bots) && req.body.bots.length ? req.body.bots.map(validateBotName) : ["Bot"];
    server.bots = [...new Set(bots)];
    config.servers.push(server);
    saveConfigAtomic();

    for (const botName of server.bots) botStates.set(keyFor(server.name, botName), createState(server, botName));
    const startNow = req.body?.start === true;
    if (startNow) {
      for (const botName of server.bots) {
        const state = botStates.get(keyFor(server.name, botName));
        if (state) await startBot(state);
      }
    }
    res.json({ success: true, msg: `Server ${server.name} added.` });
  } catch (error) {
    res.status(400).json({ success: false, msg: error.message || "Could not add server." });
  }
});

app.post("/api/server/remove", apiProtection, async (req, res) => {
  try {
    const name = safeString(req.body?.server);
    const index = config.servers.findIndex(server => String(server.name) === name);
    if (index < 0) return res.status(404).json({ success: false, msg: "Server not found." });
    if (config.servers.length <= 1) return res.status(400).json({ success: false, msg: "Keep at least one server configured." });

    const server = config.servers[index];
    for (const botName of server.bots || []) {
      const state = botStates.get(keyFor(name, botName));
      if (state) await stopBot(state, "server removed");
      botStates.delete(keyFor(name, botName));
    }
    config.servers.splice(index, 1);
    saveConfigAtomic();
    res.json({ success: true, msg: `Server ${name} removed.` });
  } catch (error) {
    res.status(400).json({ success: false, msg: error.message || "Could not remove server." });
  }
});

app.post("/api/bot/add", apiProtection, async (req, res) => {
  try {
    const serverName = safeString(req.body?.server);
    const botName = validateBotName(req.body?.bot);
    const server = getServerConfig(serverName);
    if (!server) return res.status(404).json({ success: false, msg: "Server not found." });
    if (server.bots.includes(botName)) return res.status(409).json({ success: false, msg: "That bot already exists on this server." });

    server.bots.push(botName);
    saveConfigAtomic();
    const state = createState(server, botName);
    botStates.set(state.key, state);
    if (req.body?.start === true) await startBot(state);
    res.json({ success: true, msg: `${botName} added to ${serverName}.` });
  } catch (error) {
    res.status(400).json({ success: false, msg: error.message || "Could not add bot." });
  }
});

app.post("/api/bot/remove", apiProtection, async (req, res) => {
  try {
    const serverName = safeString(req.body?.server);
    const botName = validateBotName(req.body?.bot);
    const server = getServerConfig(serverName);
    if (!server) return res.status(404).json({ success: false, msg: "Server not found." });
    if (!server.bots.includes(botName)) return res.status(404).json({ success: false, msg: "Bot not found." });
    if (server.bots.length <= 1) return res.status(400).json({ success: false, msg: "A server must keep at least one bot. Remove the server instead." });

    const state = botStates.get(keyFor(serverName, botName));
    if (state) await stopBot(state, "bot removed");
    botStates.delete(keyFor(serverName, botName));
    server.bots = server.bots.filter(name => name !== botName);
    saveConfigAtomic();
    res.json({ success: true, msg: `${botName} removed from ${serverName}.` });
  } catch (error) {
    res.status(400).json({ success: false, msg: error.message || "Could not remove bot." });
  }
});

app.post("/api/config/save", apiProtection, (req, res) => {
  try {
    if (req.body?.utils) config.utils = { ...config.utils, ...req.body.utils };
    if (req.body?.movement) config.movement = { ...config.movement, ...req.body.movement };
    if (req.body?.modules) config.modules = { ...config.modules, ...req.body.modules };
    if (req.body?.combat) config.combat = { ...config.combat, ...req.body.combat };
    if (req.body?.chat) config.chat = { ...config.chat, ...req.body.chat };
    if (req.body?.performance) config.performance = { ...config.performance, ...req.body.performance };
    saveConfigAtomic();
    res.json({ success: true, msg: "Settings saved." });
  } catch (error) {
    res.status(400).json({ success: false, msg: error.message || "Settings could not be saved." });
  }
});

// Optional GitHub sync using server-side environment variables.
// Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO and optionally GITHUB_BRANCH in Wispbyte.
function githubRequest(method, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.github.com",
      path: pathname,
      method,
      headers: {
        "User-Agent": "minecraft-bot-dashboard",
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {})
      },
      timeout: 10000
    }, response => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(data || "{}"); } catch (_) { parsed = { raw: data }; }
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
        else reject(new Error(`GitHub API ${response.statusCode}: ${parsed?.message || data}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("GitHub request timed out.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

app.get("/api/github/status", apiProtection, (_req, res) => {
  const configured = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO);
  res.json({
    configured,
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || "",
    branch: process.env.GITHUB_BRANCH || "main"
  });
});

app.post("/api/github/sync", apiProtection, async (_req, res) => {
  try {
    const token = String(process.env.GITHUB_TOKEN || "").trim();
    const owner = String(process.env.GITHUB_OWNER || "").trim();
    const repo = String(process.env.GITHUB_REPO || "").trim();
    const branch = String(process.env.GITHUB_BRANCH || "main").trim() || "main";
    if (!token || !owner || !repo) return res.status(400).json({ success: false, msg: "GitHub sync is not configured on the server." });

    const current = await githubRequest("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/settings.json?ref=${encodeURIComponent(branch)}`, token);
    const sha = current.sha;
    const content = Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8").toString("base64");
    const body = JSON.stringify({ message: "chore: update bot settings from dashboard", content, sha, branch });
    await githubRequest("PUT", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/settings.json`, token, body);
    res.json({ success: true, msg: "settings.json committed to GitHub." });
  } catch (error) {
    res.status(400).json({ success: false, msg: error.message || "GitHub sync failed." });
  }
});

app.get("/api/health", apiProtection, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    configuredConnections: botStates.size,
    connected: [...botStates.values()].filter(state => state.connected).length
  });
});

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft Bot Control Center</title>
<style>
:root{
  --bg:#090c11;--panel:#11161d;--panel2:#151b23;--border:#27313d;--text:#f4f7fb;--muted:#8d99a8;
  --accent:#7c5cff;--accent2:#9b87ff;--good:#31c48d;--warn:#f5b942;--bad:#ff6678;--shadow:0 20px 60px rgba(0,0,0,.28)
}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:radial-gradient(circle at 20% 0%,rgba(124,92,255,.14),transparent 35%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}
button,input,select,textarea{font:inherit}button{border:0}.app{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.sidebar{border-right:1px solid var(--border);background:rgba(10,13,18,.86);backdrop-filter:blur(18px);padding:22px 16px;position:sticky;top:0;height:100vh}.brand{display:flex;align-items:center;gap:11px;padding:8px 10px 24px}.brand-icon{width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#4d3eb7);display:grid;place-items:center;font-weight:900;box-shadow:0 10px 30px rgba(124,92,255,.35)}.brand h1{font-size:15px;margin:0}.brand p{font-size:11px;color:var(--muted);margin:2px 0 0}.nav{display:grid;gap:6px}.nav button{background:transparent;color:var(--muted);padding:11px 12px;border-radius:10px;text-align:left;cursor:pointer;transition:.18s;display:flex;align-items:center;gap:10px}.nav button:hover,.nav button.active{background:#171d27;color:var(--text)}.nav button.active{box-shadow:inset 2px 0 0 var(--accent)}.sidebar-bottom{position:absolute;left:16px;right:16px;bottom:18px;color:var(--muted);font-size:11px}.main{padding:30px;max-width:1500px;width:100%;margin:auto}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.eyebrow{color:var(--accent2);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em}.title{font-size:32px;margin:4px 0 6px}.subtitle{margin:0;color:var(--muted);font-size:14px}.top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.btn{background:#171e28;border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:10px;cursor:pointer}.btn:hover{background:#1d2631}.btn.primary{background:linear-gradient(135deg,var(--accent),#6552d9);border-color:transparent}.btn.danger{color:#ffd9de;border-color:#5d2c35}.btn.small{padding:8px 10px;font-size:12px}.grid-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.stat{background:linear-gradient(180deg,rgba(21,27,35,.96),rgba(15,20,27,.96));border:1px solid var(--border);border-radius:15px;padding:18px;box-shadow:var(--shadow)}.stat .label{color:var(--muted);font-size:12px}.stat .value{font-size:25px;font-weight:800;margin-top:8px}.section{display:none}.section.active{display:block}.server{border:1px solid var(--border);background:rgba(17,22,29,.93);border-radius:18px;padding:18px;margin-bottom:16px;box-shadow:var(--shadow)}.server-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}.server-title{display:flex;align-items:center;gap:12px}.server-title h2{font-size:18px;margin:0}.server-meta{color:var(--muted);font-size:12px;margin-top:3px}.status-pill{display:inline-flex;align-items:center;gap:7px;padding:6px 9px;border-radius:999px;background:#161d26;border:1px solid var(--border);font-size:11px}.dot{width:7px;height:7px;border-radius:50%;background:#718096}.dot.good{background:var(--good);box-shadow:0 0 0 3px rgba(49,196,141,.1)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.server-actions{display:flex;gap:7px;flex-wrap:wrap}.bots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.bot-card{border:1px solid var(--border);background:#0f141a;border-radius:14px;padding:15px}.bot-top{display:flex;justify-content:space-between;gap:12px}.bot-name{font-weight:800}.bot-sub{font-size:12px;color:var(--muted);margin-top:3px}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0}.metric{padding:10px;border:1px solid #202832;border-radius:10px;background:#121820}.metric span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.metric strong{display:block;font-size:12px;margin-top:4px}.bot-actions{display:flex;gap:7px;flex-wrap:wrap}.empty{padding:40px;border:1px dashed var(--border);border-radius:14px;text-align:center;color:var(--muted)}.panel{background:rgba(17,22,29,.93);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.panel-head{padding:15px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:12px;align-items:center}.panel-body{padding:16px}.console-layout{display:grid;grid-template-columns:290px 1fr;min-height:640px}.console-list{border-right:1px solid var(--border);padding:12px;background:#0d1218}.console-item{width:100%;padding:12px;border:1px solid transparent;background:transparent;color:var(--text);text-align:left;border-radius:11px;cursor:pointer;margin-bottom:6px}.console-item:hover{background:#151b23}.console-item.active{background:#191f29;border-color:#2b3441}.console-item strong{display:block}.console-item small{color:var(--muted)}.console-main{display:flex;flex-direction:column;min-width:0}.console-log{flex:1;min-height:480px;max-height:560px;overflow:auto;padding:16px;background:#090d12;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;line-height:1.55}.log-line{white-space:pre-wrap;word-break:break-word;margin-bottom:4px}.log-line.success{color:#9de9c7}.log-line.warn{color:#f7cf7b}.log-line.error{color:#ff9da9}.log-line.control{color:#b8aaff}.log-line.chat{color:#9cb8ff}.console-form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--border);background:#0f141a}.console-form input{flex:1;background:#0c1117;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:11px 12px;outline:none}.console-form input:focus{border-color:var(--accent)}.console-select{background:#11171f;border:1px solid var(--border);color:var(--text);padding:10px;border-radius:10px}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;padding:12px;border-bottom:1px solid #202832;font-size:13px}.table th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field{display:grid;gap:6px}.field label{font-size:11px;color:var(--muted)}.field input,.field select,.field textarea{width:100%;background:#0d131a;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:10px;outline:none}.field textarea{min-height:90px;resize:vertical}.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--accent)}.wide{grid-column:1/-1}.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.62);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:20px;z-index:50}.modal{width:min(650px,100%);background:#121821;border:1px solid var(--border);border-radius:18px;box-shadow:0 30px 100px rgba(0,0,0,.5)}.modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--border)}.modal-body{padding:18px}.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.toast{position:fixed;right:20px;bottom:20px;z-index:100;display:grid;gap:8px}.toast-item{background:#111821;border:1px solid var(--border);padding:11px 13px;border-radius:11px;box-shadow:var(--shadow);font-size:13px}.toast-item.error{border-color:#5b2b35}.login{position:fixed;inset:0;background:var(--bg);display:none;align-items:center;justify-content:center;padding:20px;z-index:200}.login-card{width:min(420px,100%);background:#121821;border:1px solid var(--border);border-radius:18px;padding:24px;box-shadow:var(--shadow)}.login-card h2{margin:0 0 6px}.login-card p{color:var(--muted);font-size:13px;margin:0 0 18px}.hidden{display:none!important}@media(max-width:1050px){.app{grid-template-columns:1fr}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--border)}.nav{grid-template-columns:repeat(4,1fr)}.sidebar-bottom{display:none}.main{padding:20px}.grid-stats{grid-template-columns:repeat(2,1fr)}.bots{grid-template-columns:1fr}.console-layout{grid-template-columns:1fr}.console-list{border-right:0;border-bottom:1px solid var(--border);max-height:220px;overflow:auto}}@media(max-width:650px){.topbar{align-items:flex-start;flex-direction:column}.title{font-size:26px}.grid-stats{grid-template-columns:1fr 1fr}.form-grid{grid-template-columns:1fr}.nav{grid-template-columns:repeat(2,1fr)}.main{padding:14px}.server-head{flex-direction:column}.server-actions{width:100%}}
</style>
</head>
<body>
<div id="login" class="login"><div class="login-card"><div class="eyebrow">SECURE CONTROL PANEL</div><h2>Sign in</h2><p>This dashboard is protected by the server-side dashboard password.</p><div class="field"><label>Password</label><input id="login-password" type="password" autocomplete="current-password"></div><div class="modal-actions"><button class="btn primary" id="login-button">Enter dashboard</button></div></div></div>
<div class="app">
<aside class="sidebar"><div class="brand"><div class="brand-icon">MC</div><div><h1>Bot Control Center</h1><p>Multi-server Mineflayer</p></div></div><div class="nav"><button class="active" data-section="overview">◈ Overview</button><button data-section="console">⌘ Console</button><button data-section="servers">▣ Servers</button><button data-section="settings">⚙ Settings</button></div><div class="sidebar-bottom">Live control • live configuration</div></aside>
<main class="main">
<div class="topbar"><div><div class="eyebrow">OPERATIONS</div><div class="title">Minecraft Bot Dashboard</div><p class="subtitle">Manage every server and bot from one polished control center.</p></div><div class="top-actions"><button class="btn small" onclick="controlAll('start')">Start all</button><button class="btn small" onclick="controlAll('stop')">Stop all</button><button class="btn primary" onclick="openServerModal()">+ Add server</button></div></div>
<section id="overview" class="section active"><div class="grid-stats"><div class="stat"><div class="label">Configured connections</div><div class="value" id="stat-total">—</div></div><div class="stat"><div class="label">Online bots</div><div class="value" id="stat-online">—</div></div><div class="stat"><div class="label">Servers</div><div class="value" id="stat-servers">—</div></div><div class="stat"><div class="label">Node memory</div><div class="value" id="stat-memory">—</div></div></div><div id="overview-content"></div></section>
<section id="console" class="section"><div class="panel"><div class="panel-head"><div><strong>Bot Console</strong><div style="color:var(--muted);font-size:12px;margin-top:3px">Live logs, chat and commands</div></div><select id="console-target" class="console-select" onchange="selectConsoleTarget(this.value)"></select></div><div class="console-layout"><div class="console-list" id="console-list"></div><div class="console-main"><div class="console-log" id="console-log"></div><div class="console-form"><input id="console-input" autocomplete="off" spellcheck="false" placeholder="Type / for commands, or any Minecraft chat…"><button class="btn primary" onclick="sendConsole()">Send</button></div></div></div></div></section>
<section id="servers" class="section"><div class="panel"><div class="panel-head"><div><strong>Servers</strong><div style="color:var(--muted);font-size:12px;margin-top:3px">Add or remove servers without editing settings.json</div></div><button class="btn primary small" onclick="openServerModal()">+ Add server</button></div><div class="panel-body"><div id="server-table"></div></div></div></section>
<section id="settings" class="section"><div class="panel"><div class="panel-head"><div><strong>Runtime settings</strong><div style="color:var(--muted);font-size:12px;margin-top:3px">Changes are written back to settings.json</div></div><button class="btn primary small" onclick="saveSettings()">Save settings</button></div><div class="panel-body"><div class="form-grid"><div class="field"><label>Auto reconnect</label><select id="set-autoreconnect"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field"><label>Reconnect delay (ms)</label><input id="set-reconnectdelay" type="number" min="1000"></div><div class="field"><label>View distance</label><input id="set-viewdistance" type="number" min="2" max="8"></div><div class="field"><label>Physics</label><select id="set-physics"><option value="false">Disabled (RAM friendly)</option><option value="true">Enabled</option></select></div><div class="field"><label>Anti-AFK</label><select id="set-antiafk"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field"><label>Combat</label><select id="set-combat"><option value="true">Enabled</option><option value="false">Disabled</option></select></div><div class="field wide"><label>Auto chat messages (one per line)</label><textarea id="set-chatmessages"></textarea></div></div><div style="margin-top:18px;border-top:1px solid var(--border);padding-top:18px"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><strong>GitHub sync</strong><div id="github-status" style="color:var(--muted);font-size:12px;margin-top:4px">Checking server configuration…</div></div><button class="btn small" onclick="syncGithub()">Commit settings.json</button></div></div></div></div></section>
</main></div>
<div id="modal-backdrop" class="modal-backdrop"><div class="modal"><div class="modal-head"><strong id="modal-title">Add server</strong><button class="btn small" onclick="closeModal()">Close</button></div><div class="modal-body" id="modal-body"></div></div></div>
<div class="toast" id="toast"></div>
<script>
let state=null;let selectedTarget="";let pollTimer=null;let consoleTimer=null;let consoleHistory=[];let historyIndex=-1;
const $=id=>document.getElementById(id);
function toast(msg,error=false){const el=document.createElement('div');el.className='toast-item'+(error?' error':'');el.textContent=msg;$('toast').appendChild(el);setTimeout(()=>el.remove(),3400)}
async function api(url,options={}){const res=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});if(res.status===401){showLogin();throw new Error('Authentication required')}const data=await res.json().catch(()=>({}));if(!res.ok||data.success===false)throw new Error(data.msg||'Request failed');return data}
function showLogin(){$('login').style.display='flex'}
async function boot(){const auth=await fetch('/api/auth').then(r=>r.json());if(auth.required&&!auth.authenticated){showLogin();return}bindNav();bindConsole();await refresh();pollTimer=setInterval(refresh,3000);consoleTimer=setInterval(refreshConsole,2000)}
function bindNav(){document.querySelectorAll('.nav button').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));$(btn.dataset.section).classList.add('active');if(btn.dataset.section==='console'){renderConsoleList();refreshConsole()}})}
function bindConsole(){const input=$('console-input');input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendConsole()}if(e.key==='ArrowUp'){e.preventDefault();if(consoleHistory.length){historyIndex=Math.max(0,historyIndex-1);input.value=consoleHistory[historyIndex]||''}}if(e.key==='ArrowDown'){e.preventDefault();if(consoleHistory.length){historyIndex=Math.min(consoleHistory.length,historyIndex+1);input.value=consoleHistory[historyIndex]||''}}});}
async function refresh(){try{state=await api('/api/state');renderStats();renderOverview();renderServerTable();renderConsoleList();fillSettings();}catch(e){toast(e.message,true)}}
function renderStats(){const bots=state.bots||[];$('stat-total').textContent=bots.length;$('stat-online').textContent=bots.filter(x=>x.status==='connected').length;$('stat-servers').textContent=state.servers.length;$('stat-memory').textContent=state.memoryMB+' MB'}
function positionText(bot){return bot.coords?\`X \${Math.floor(bot.coords.x)}, Y \${Math.floor(bot.coords.y)}, Z \${Math.floor(bot.coords.z)}\`:'Position unavailable'}
function renderOverview(){const wrap=$('overview-content');const grouped=new Map();for(const server of state.servers)grouped.set(server.name,[]);for(const bot of state.bots){if(!grouped.has(bot.server))grouped.set(bot.server,[]);grouped.get(bot.server).push(bot)}if(!grouped.size){wrap.innerHTML='<div class="empty">No servers configured.</div>';return}wrap.innerHTML=[...grouped.entries()].map(([serverName,bots])=>{const server=state.servers.find(s=>s.name===serverName)||{};const online=bots.filter(b=>b.status==='connected').length;return \`<div class="server"><div class="server-head"><div class="server-title"><div><div class="status-pill"><span class="dot \${online?'good':''}"></span>\${online}/\${bots.length} online</div></div><div><h2>\${esc(serverName)}</h2><div class="server-meta">\${esc(server.ip)}:\${server.port} • \${esc(server.version||'auto')} • \${esc(server.auth||'offline')}</div></div></div><div class="server-actions"><button class="btn small" onclick="openBotModal('\${js(serverName)}')">+ Bot</button><button class="btn small danger" onclick="removeServer('\${js(serverName)}')">Remove</button></div></div><div class="bots">\${bots.map(renderBotCard).join('')}</div></div>\`}).join('')}
function renderBotCard(bot){const cls=bot.status==='connected'?'good':bot.status==='connecting'?'warn':'bad';return \`<div class="bot-card"><div class="bot-top"><div><div class="bot-name">\${esc(bot.bot)}</div><div class="bot-sub">\${esc(bot.server)}</div></div><div class="status-pill"><span class="dot \${cls}"></span>\${esc(bot.status)}</div></div><div class="metrics"><div class="metric"><span>Position</span><strong>\${esc(positionText(bot))}</strong></div><div class="metric"><span>Uptime</span><strong>\${esc(formatUptime(bot.uptime))}</strong></div><div class="metric"><span>RAM</span><strong>\${bot.memoryMB} MB</strong></div><div class="metric"><span>Reconnects</span><strong>\${bot.reconnectAttempts}</strong></div></div><div class="bot-actions"><button class="btn small" onclick="controlBot('\${js(bot.server)}','\${js(bot.bot)}','start')">Start</button><button class="btn small" onclick="controlBot('\${js(bot.server)}','\${js(bot.bot)}','stop')">Stop</button><button class="btn small" onclick="controlBot('\${js(bot.server)}','\${js(bot.bot)}','restart')">Restart</button><button class="btn small" onclick="openConsole('\${js(bot.server)}','\${js(bot.bot)}')">Console</button><button class="btn small danger" onclick="removeBot('\${js(bot.server)}','\${js(bot.bot)}')">Remove</button></div></div>\`}
function renderServerTable(){const html=state.servers.length?\`<table class="table"><thead><tr><th>Server</th><th>Address</th><th>Version</th><th>Bots</th><th></th></tr></thead><tbody>\${state.servers.map(s=>\`<tr><td><strong>\${esc(s.name)}</strong></td><td>\${esc(s.ip)}:\${s.port}</td><td>\${esc(s.version||'auto')}</td><td>\${s.bots.length}</td><td><div style="display:flex;gap:7px;justify-content:flex-end"><button class="btn small" onclick="openBotModal('\${js(s.name)}')">Add bot</button><button class="btn small danger" onclick="removeServer('\${js(s.name)}')">Remove</button></div></td></tr>\`).join('')}</tbody></table>\`:'<div class="empty">No servers configured.</div>';$('server-table').innerHTML=html}
function renderConsoleList(){const items=state?state.bots:[];$('console-list').innerHTML=items.map(b=>\`<button class="console-item \${b.key===selectedTarget?'active':''}" onclick="selectConsoleTarget('\${js(b.key)}')"><strong>\${esc(b.bot)}</strong><small>\${esc(b.server)}</small></button>\`).join('');$('console-target').innerHTML=items.map(b=>\`<option value="\${esc(b.key)}" \${b.key===selectedTarget?'selected':''}>\${esc(b.server)} / \${esc(b.bot)}</option>\`).join('');if(!selectedTarget&&items[0])selectedTarget=items[0].key;if(selectedTarget)$('console-target').value=selectedTarget}
function selectConsoleTarget(key){selectedTarget=key;renderConsoleList();refreshConsole()}
function getSelected(){return (state?.bots||[]).find(b=>b.key===selectedTarget)||null}
async function refreshConsole(){const target=getSelected();if(!target)return;$('console-log').innerHTML='<div style="color:var(--muted)">Loading…</div>';try{const d=await api('/api/logs?server='+encodeURIComponent(target.server)+'&bot='+encodeURIComponent(target.bot));$('console-log').innerHTML=(d.logs||[]).map(x=>\`<div class="log-line \${esc(x.level)}">\${esc(x.message)}</div>\`).join('')||'<div style="color:var(--muted)">No logs yet.</div>';$('console-log').scrollTop=$('console-log').scrollHeight}catch(e){$('console-log').textContent=e.message}}
async function sendConsole(){const target=getSelected();const input=$('console-input');const command=input.value.trim();if(!target||!command)return;consoleHistory.push(command);if(consoleHistory.length>50)consoleHistory.shift();historyIndex=consoleHistory.length;input.value='';try{const d=await api('/api/command',{method:'POST',body:JSON.stringify({server:target.server,bot:target.bot,command})});toast(d.msg||'Done');refreshConsole()}catch(e){toast(e.message,true)}}
function openConsole(server,bot){document.querySelector('.nav button[data-section="console"]').click();selectedTarget=server+'::'+bot;renderConsoleList();refreshConsole();setTimeout(()=>$('console-input').focus(),50)}
async function controlBot(server,bot,action){try{const d=await api('/api/control',{method:'POST',body:JSON.stringify({server,bot,action})});toast(d.msg||'Done');setTimeout(refresh,500)}catch(e){toast(e.message,true)}}
async function controlAll(action){try{const d=await api('/api/control-all',{method:'POST',body:JSON.stringify({action})});toast(d.msg||'Done');setTimeout(refresh,800)}catch(e){toast(e.message,true)}}
function openServerModal(){openModal('Add server',\`<form id="server-form"><div class="form-grid"><div class="field"><label>Server name</label><input id="sf-name" required placeholder="HardCraft"></div><div class="field"><label>Address</label><input id="sf-ip" required placeholder="play.example.com"></div><div class="field"><label>Port</label><input id="sf-port" type="number" min="1" max="65535" value="25565" required></div><div class="field"><label>Minecraft version</label><input id="sf-version" value="1.20.1" placeholder="1.20.1"></div><div class="field"><label>Authentication</label><select id="sf-auth"><option value="offline">Offline</option><option value="microsoft">Microsoft</option></select></div><div class="field"><label>Start bots immediately</label><select id="sf-start"><option value="true">Yes</option><option value="false">No</option></select></div><div class="field wide"><label>Bots (comma separated)</label><input id="sf-bots" value="Chomubot, ChowminBot"></div></div><div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button type="submit" class="btn primary">Add server</button></div></form>\`);$('server-form').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/server/add',{method:'POST',body:JSON.stringify({name:$('sf-name').value,ip:$('sf-ip').value,port:Number($('sf-port').value),version:$('sf-version').value,auth:$('sf-auth').value,start:$('sf-start').value==='true',bots:$('sf-bots').value.split(',').map(x=>x.trim()).filter(Boolean)})});toast(d.msg);closeModal();await refresh()}catch(err){toast(err.message,true)}}}
function openBotModal(server){openModal('Add bot to '+server,\`<form id="bot-form"><div class="form-grid"><div class="field wide"><label>Bot name</label><input id="bf-name" required maxlength="16" pattern="[A-Za-z0-9_]+" placeholder="NewBot"></div><div class="field"><label>Start immediately</label><select id="bf-start"><option value="true">Yes</option><option value="false">No</option></select></div></div><div class="modal-actions"><button type="button" class="btn" onclick="closeModal()">Cancel</button><button type="submit" class="btn primary">Add bot</button></div></form>\`);$('bot-form').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/bot/add',{method:'POST',body:JSON.stringify({server,bot:$('bf-name').value,start:$('bf-start').value==='true'})});toast(d.msg);closeModal();await refresh()}catch(err){toast(err.message,true)}}}
async function removeServer(server){if(!confirm('Remove server '+server+' and stop its bots?'))return;try{const d=await api('/api/server/remove',{method:'POST',body:JSON.stringify({server})});toast(d.msg);selectedTarget='';await refresh()}catch(e){toast(e.message,true)}}
async function removeBot(server,bot){if(!confirm('Remove '+bot+' from '+server+'?'))return;try{const d=await api('/api/bot/remove',{method:'POST',body:JSON.stringify({server,bot})});toast(d.msg);if(selectedTarget===server+'::'+bot)selectedTarget='';await refresh()}catch(e){toast(e.message,true)}}
function openModal(title,html){$('modal-title').textContent=title;$('modal-body').innerHTML=html;$('modal-backdrop').style.display='flex'}function closeModal(){$('modal-backdrop').style.display='none'}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function js(v){return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
function fillSettings(){const u=state?state._config:null;/* runtime settings are loaded below */}
async function loadSettings(){try{const cfg=await api('/api/state');const s=cfg.__settings;if(!s)return}catch(_){} }
async function saveSettings(){const payload={utils:{'auto-reconnect':$('set-autoreconnect').value==='true','auto-reconnect-delay':Number($('set-reconnectdelay').value)||2000},movement:{enabled:$('set-antiafk').value==='true','circle-walk':{enabled:$('set-antiafk').value==='true'}},modules:{combat:$('set-combat').value==='true'},performance:{viewDistance:Number($('set-viewdistance').value)||2,physicsEnabled:$('set-physics').value==='true'},'chat-messages':{}};try{const lines=$('set-chatmessages').value.split('\n').map(x=>x.trim()).filter(Boolean);payload.utils['chat-messages']={enabled:lines.length>0,repeat:true,'repeat-delay':120,messages:lines};payload.utils['auto-auth']={...payload.utils['auto-auth']};await api('/api/config/save',{method:'POST',body:JSON.stringify(payload)});toast('Settings saved. Restart bots to apply connection-level changes.')}catch(e){toast(e.message,true)}}
// Settings values from server are embedded in the initial HTML by API helper below.
async function fillSettingsFromServer(){try{const res=await api('/api/runtime-settings');$('set-autoreconnect').value=String(res.settings?.utils?.['auto-reconnect']!==false);$('set-reconnectdelay').value=Number(res.settings?.utils?.['auto-reconnect-delay']||2000);$('set-viewdistance').value=Number(res.settings?.performance?.viewDistance||2);$('set-physics').value=String(res.settings?.performance?.physicsEnabled===true);$('set-antiafk').value=String(res.settings?.['movement']?.enabled!==false && res.settings?.utils?.['anti-afk']?.enabled!==false);$('set-combat').value=String(res.settings?.modules?.combat!==false);$('set-chatmessages').value=(res.settings?.utils?.['chat-messages']?.messages||[]).join('\n')}catch(e){}}
async function loadGithub(){try{const d=await api('/api/github/status');$('github-status').textContent=d.configured?\`Configured for \${d.owner}/\${d.repo} • branch \${d.branch}\`:'Not configured. Add GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO on Wispbyte.'}catch(e){$('github-status').textContent=e.message}}
async function syncGithub(){try{const d=await api('/api/github/sync',{method:'POST',body:'{}'});toast(d.msg||'GitHub sync complete.')}catch(e){toast(e.message,true)}}
$('login-button').onclick=async()=>{try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('login-password').value})});$('login').style.display='none';location.reload()}catch(e){toast(e.message,true)}};
$('login-password').addEventListener('keydown',e=>{if(e.key==='Enter')$('login-button').click()});
boot().then(()=>{fillSettingsFromServer();loadGithub();}).catch(e=>toast(e.message,true));
</script>
</body></html>`;

app.get("/api/runtime-settings", apiProtection, (_req, res) => {
  res.json({ settings: {
    utils: config.utils,
    movement: config.movement,
    modules: config.modules,
    combat: config.combat,
    performance: config.performance
  }});
});

app.get("/", (_req, res) => res.type("html").send(DASHBOARD_HTML));
app.get("/ping", (_req, res) => res.send("pong"));

app.get("/health", apiProtection, (_req, res) => {
  res.json({ ok: true, configured: botStates.size, connected: [...botStates.values()].filter(x => x.connected).length });
});

process.on("uncaughtException", error => {
  console.error("[PROCESS] Uncaught exception:", error);
  const first = [...botStates.values()][0];
  if (first) rememberError(first, error);
});

process.on("unhandledRejection", reason => {
  console.error("[PROCESS] Unhandled rejection:", reason);
  const first = [...botStates.values()][0];
  if (first) rememberError(first, reason);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[DASHBOARD] Listening on 0.0.0.0:${PORT}`);
  console.log(`[CONFIG] ${config.servers.length} server(s), ${botStates.size} bot connection(s).`);

  // Stagger connection attempts to reduce startup spikes on low-RAM hosts.
  let delay = 0;
  for (const state of botStates.values()) {
    setTimeout(() => {
      state.manualStop = false;
      startBot(state).catch(error => {
        rememberError(state, error);
        scheduleReconnect(state, "initial startup failed");
      });
    }, delay);
    delay += 1200;
  }
});

server.on("error", error => console.error("[HTTP] Server error:", error));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[PROCESS] Received ${signal}; shutting down.`);
  for (const state of botStates.values()) {
    try { await stopBot(state, `shutdown ${signal}`); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
