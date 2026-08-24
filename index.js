"use strict";

const mineflayer = require("mineflayer");
const express = require("express");

const { addLog, getLogs } = require("./logger");
const skins = require("./skin");
const config = require("./settings.json");

const app = express();
app.use(express.json({ limit: "16kb" }));

// ============================================================
// CONFIG
// ============================================================

const WEB_PORT = Number(process.env.PORT) || 5000;

const HOST =
  config.server?.ip || "localhost";

const MC_PORT =
  Number(config.server?.port) || 25565;

const VERSION =
  config.server?.version || undefined;

const AUTH =
  config["bot-account"]?.type || "offline";

const STATES = new Map();

let shuttingDown = false;

// ============================================================
// LOGGING
// ============================================================

function log(message) {
  const text = String(message);

  console.log(text);

  try {
    addLog(text);
  } catch (_) {}
}

function recordError(state, error) {
  const text =
    error instanceof Error
      ? error.stack || error.message
      : String(error);

  state.errors.push({
    time: Date.now(),
    message: text.slice(0, 2000)
  });

  if (state.errors.length > 20) {
    state.errors.shift();
  }

  log(`[${state.name}] ${text}`);
}

// ============================================================
// BOT STATES
// ============================================================

if (!Array.isArray(config.bots)) {
  throw new Error(
    'settings.json must contain a "bots" array.'
  );
}

for (const rawName of config.bots) {
  const name = String(rawName).trim();

  if (!name || STATES.has(name)) {
    continue;
  }

  STATES.set(name, {
    name,

    bot: null,

    connected: false,
    connecting: false,
    manualStop: false,

    generation: 0,

    reconnectTimer: null,
    authTimer: null,
    skinTimer: null,
    afkTimer: null,

    reconnectAttempts: 0,

    errors: []
  });
}

if (STATES.size === 0) {
  throw new Error("No bots configured.");
}

// ============================================================
// HELPERS
// ============================================================

function getState(name) {
  return STATES.get(String(name)) || null;
}

function clearReconnect(state) {
  if (!state.reconnectTimer) return;

  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function clearTimers(state) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  if (state.authTimer) {
    clearTimeout(state.authTimer);
    state.authTimer = null;
  }

  if (state.skinTimer) {
    clearTimeout(state.skinTimer);
    state.skinTimer = null;
  }

  if (state.afkTimer) {
    clearInterval(state.afkTimer);
    state.afkTimer = null;
  }
}

// ============================================================
// SKIN
// ============================================================

function applySkin(state) {
  const skin = skins[state.name];

  if (!skin?.customName) {
    log(
      `[${state.name}] No custom skin configured.`
    );

    return {
      success: false,
      msg: `${state.name}: no skin configured.`
    };
  }

  if (!state.bot || !state.connected) {
    return {
      success: false,
      msg: `${state.name} is not connected.`
    };
  }

  try {
    state.bot.chat(
      `/skin ${skin.customName}`
    );

    log(
      `[${state.name}] Skin command sent: ${skin.customName}`
    );

    return {
      success: true,
      msg:
        `${state.name}: skin command sent.`
    };
  } catch (error) {
    recordError(state, error);

    return {
      success: false,
      msg:
        `${state.name}: failed to apply skin.`
    };
  }
}

// ============================================================
// ANTI-AFK
// ============================================================

function startAntiAfk(state) {
  if (
    !config["anti-afk"]?.enabled ||
    !state.bot
  ) {
    return;
  }

  if (state.afkTimer) {
    clearInterval(state.afkTimer);
  }

  const interval = Math.max(
    60000,
    Number(config["anti-afk"].interval) || 120000
  );

  const pulse = Math.max(
    50,
    Number(config["anti-afk"].pulse) || 150
  );

  state.afkTimer = setInterval(() => {
    const bot = state.bot;

    if (
      !bot ||
      !state.connected ||
      state.manualStop ||
      shuttingDown
    ) {
      return;
    }

    try {
      bot.setControlState(
        "forward",
        true
      );

      setTimeout(() => {
        if (state.bot !== bot) return;

        try {
          bot.setControlState(
            "forward",
            false
          );
        } catch (_) {}
      }, pulse);

    } catch (error) {
      recordError(state, error);
    }
  }, interval);

  log(
    `[${state.name}] Anti-AFK enabled: ${Math.round(
      interval / 1000
    )}s pulse interval.`
  );
}

// ============================================================
// AUTO LOGIN
// ============================================================

function startAutoAuth(state) {
  const auth = config.utils?.["auto-auth"];

  if (!auth?.enabled || !auth.password) {
    return;
  }

  if (state.authTimer) {
    clearTimeout(state.authTimer);
  }

  state.authTimer = setTimeout(() => {
    state.authTimer = null;

    if (!state.bot || !state.connected) {
      return;
    }

    try {
      state.bot.chat(
        `/login ${auth.password}`
      );

      log(
        `[${state.name}] Auto-auth command sent.`
      );
    } catch (error) {
      recordError(state, error);
    }
  }, 3000);
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupBot(
  state,
  reason = "cleanup"
) {
  clearTimers(state);

  const bot = state.bot;

  state.bot = null;
  state.connected = false;
  state.connecting = false;

  if (!bot) return;

  try {
    bot.clearControlStates();
  } catch (_) {}

  try {
    bot.quit(reason);
  } catch (_) {}

  try {
    bot._client?.socket?.destroy();
  } catch (_) {}
}

// ============================================================
// RECONNECT
// ============================================================

function scheduleReconnect(
  state,
  reason = ""
) {
  if (
    shuttingDown ||
    state.manualStop ||
    state.bot ||
    state.connecting ||
    state.reconnectTimer ||
    !config.utils?.["auto-reconnect"]
  ) {
    return;
  }

  const base = Math.max(
    30000,
    Number(
      config.utils["auto-reconnect-delay"]
    ) || 30000
  );

  const maximum = Math.max(
    base,
    Number(
      config.utils["max-reconnect-delay"]
    ) || 180000
  );

  const delay = Math.min(
    maximum,
    base *
      Math.pow(
        2,
        Math.min(
          state.reconnectAttempts,
          3
        )
      )
  );

  state.reconnectAttempts++;

  log(
    `[${state.name}] Reconnecting in ${Math.ceil(
      delay / 1000
    )}s${
      reason ? ` (${reason})` : ""
    }`
  );

  state.reconnectTimer =
    setTimeout(() => {
      state.reconnectTimer = null;

      if (shuttingDown) return;

      startBot(state);
    }, delay);
}

// ============================================================
// START BOT
// ============================================================

async function startBot(state) {
  if (
    shuttingDown ||
    state.bot ||
    state.connecting
  ) {
    return false;
  }

  state.manualStop = false;
  clearReconnect(state);

  state.connecting = true;

  const generation =
    ++state.generation;

  try {
    log(
      `[${state.name}] Connecting to ${HOST}:${MC_PORT}...`
    );

    /*
    These are deliberately close to the settings
    that already successfully spawned your bots.

    No Pathfinder.
    No combat.
    No entity scanning.
    */

    const bot =
      mineflayer.createBot({
        host: HOST,

        port: MC_PORT,

        username:
          state.name,

        auth: AUTH,

        password:
          config["bot-account"]?.password ||
          undefined,

        version: VERSION,

        physicsEnabled: true,

        viewDistance: 2,

        chatLog: false,

        checkTimeoutInterval: 30000,

        connectTimeout: 30000,

        hideErrors: false
      });

    state.bot = bot;

    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------

    bot.once("login", () => {
      if (
        generation !== state.generation
      ) {
        return;
      }

      log(
        `[${state.name}] Logged in.`
      );
    });

    // --------------------------------------------------------
    // SPAWN
    // --------------------------------------------------------

    bot.once("spawn", () => {
      if (
        generation !== state.generation ||
        state.bot !== bot
      ) {
        return;
      }

      state.connected = true;
      state.reconnectAttempts = 0;

      log(
        `[${state.name}] Spawned successfully.`
      );

      startAutoAuth(state);

      /*
      Apply the custom skin only once after
      the player has completely spawned.
      */

      if (state.skinTimer) {
        clearTimeout(
          state.skinTimer
        );
      }

      state.skinTimer =
        setTimeout(() => {
          state.skinTimer = null;

          if (
            state.bot === bot &&
            state.connected &&
            generation === state.generation
          ) {
            applySkin(state);
          }
        }, 5000);

      startAntiAfk(state);
    });

    // --------------------------------------------------------
    // CHAT
    // --------------------------------------------------------

    bot.on(
      "chat",
      (
        username,
        message
      ) => {
        if (
          generation !==
          state.generation
        ) {
          return;
        }

        if (
          config.utils?.[
            "chat-log"
          ]
        ) {
          log(
            `[${state.name}] <${username}> ${message}`
          );
        }

        /*
        Very simple response.
        */

        if (
          config.chat?.respond &&
          username !== state.name
        ) {
          const text =
            String(message)
              .toLowerCase()
              .trim();

          if (
            text === "hi" ||
            text === "hello" ||
            text === "hey"
          ) {
            try {
              bot.chat(
                `Hello ${username}!`
              );
            } catch (_) {}
          }
        }
      }
    );

    // --------------------------------------------------------
    // KICK
    // --------------------------------------------------------

    bot.on(
      "kicked",
      reason => {
        if (
          generation !==
          state.generation
        ) {
          return;
        }

        log(
          `[${state.name}] Kicked: ${String(
            reason
          )}`
        );
      }
    );

    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    bot.on(
      "error",
      error => {
        if (
          generation !==
          state.generation
        ) {
          return;
        }

        recordError(
          state,
          error
        );
      }
    );

    // --------------------------------------------------------
    // END
    // --------------------------------------------------------

    bot.on(
      "end",
      reason => {
        if (
          generation !==
          state.generation
        ) {
          return;
        }

        cleanupBot(
          state,
          "connection ended"
        );

        log(
          `[${state.name}] Connection ended${
            reason
              ? `: ${reason}`
              : ""
          }`
        );

        scheduleReconnect(
          state,
          "connection ended"
        );
      }
    );

    return true;
  } catch (error) {
    state.bot = null;

    recordError(
      state,
      error
    );

    scheduleReconnect(
      state,
      "start failed"
    );

    return false;
  } finally {
    state.connecting = false;
  }
}

// ============================================================
// STOP / RESTART
// ============================================================

async function stopBot(state) {
  if (!state) return;

  state.manualStop = true;

  state.generation++;

  clearReconnect(state);

  cleanupBot(
    state,
    "dashboard stop"
  );

  state.reconnectAttempts = 0;

  log(
    `[${state.name}] Stopped.`
  );
}

function restartBot(state) {
  if (!state) {
    return {
      success: false,
      msg: "Bot not found."
    };
  }

  stopBot(state).finally(() => {
    if (shuttingDown) return;

    setTimeout(() => {
      if (shuttingDown) return;

      state.manualStop = false;

      startBot(state);
    }, 5000);
  });

  return {
    success: true,
    msg:
      `${state.name} is restarting.`
  };
}

function restartAllBots() {
  const list =
    [...STATES.values()];

  Promise.all(
    list.map(
      state =>
        stopBot(state)
    )
  ).finally(() => {
    list.forEach(
      (state, index) => {
        setTimeout(
          () => {
            if (shuttingDown) return;

            state.manualStop = false;

            startBot(state);
          },
          5000 +
            index * 30000
        );
      }
    );
  });

  return {
    success: true,
    msg:
      "All bots are restarting."
  };
}

// ============================================================
// COMMANDS
// ============================================================

function commandHandler(
  raw,
  selectedBot
) {
  const text =
    String(raw || "").trim();

  if (!text) {
    return {
      success: false,
      msg:
        "Enter a command."
    };
  }

  const parts =
    text.split(/\s+/);

  const command =
    parts[0].toLowerCase();

  // /restartBots
  if (
    command ===
    "/restartbots"
  ) {
    return restartAllBots();
  }

  // /restartBot name
  if (
    command ===
    "/restartbot"
  ) {
    const name =
      parts[1] ||
      selectedBot;

    return restartBot(
      getState(name)
    );
  }

  // /skin name
  if (
    command ===
    "/skin"
  ) {
    const name =
      parts[1] ||
      selectedBot;

    return applySkin(
      getState(name)
    );
  }

  // /say name message
  if (
    command ===
    "/say"
  ) {
    let name =
      selectedBot;

    let start =
      1;

    if (
      parts[1] &&
      STATES.has(
        parts[1]
      )
    ) {
      name =
        parts[1];

      start =
        2;
    }

    if (!name) {
      return {
        success: false,
        msg:
          "Select a bot first."
      };
    }

    const state =
      getState(name);

    if (
      !state ||
      !state.bot ||
      !state.connected
    ) {
      return {
        success: false,
        msg:
          `${name} is not connected.`
      };
    }

    const message =
      parts
        .slice(start)
        .join(" ")
        .slice(0, 256);

    if (!message) {
      return {
        success: false,
        msg:
          "Message is empty."
      };
    }

    try {
      state.bot.chat(
        message
      );

      return {
        success: true,
        msg:
          `${name}: ${message}`
      };
    } catch (error) {
      recordError(
        state,
        error
      );

      return {
        success: false,
        msg:
          "Failed to send message."
      };
    }
  }

  return {
    success: false,
    msg:
      "Available: /say, /skin, /restartBot, /restartBots"
  };
}

// ============================================================
// COMMAND API
// ============================================================

app.post(
  "/command",
  (req, res) => {
    try {
      res.json(
        commandHandler(
          req.body?.command,
          req.body?.bot
        )
      );
    } catch (error) {
      res.status(500).json({
        success: false,
        msg:
          String(error)
      });
    }
  }
);

// ============================================================
// START / STOP API
// ============================================================

app.post(
  "/start",
  async (req, res) => {
    const name =
      req.body?.name;

    if (name) {
      const state =
        getState(name);

      if (!state) {
        return res.status(404).json({
          success: false,
          msg:
            `Unknown bot: ${name}`
        });
      }

      await startBot(state);

      return res.json({
        success: true,
        msg:
          `${name} start requested.`
      });
    }

    [...STATES.values()]
      .forEach(
        (state, index) => {
          setTimeout(
            () => {
              if (
                !shuttingDown &&
                !state.bot &&
                !state.connecting
              ) {
                startBot(
                  state
                );
              }
            },
            index * 30000
          );
        }
      );

    res.json({
      success: true,
      msg:
        "Bots scheduled 30 seconds apart."
    });
  }
);

app.post(
  "/stop",
  async (req, res) => {
    const name =
      req.body?.name;

    if (name) {
      const state =
        getState(name);

      if (!state) {
        return res.status(404).json({
          success: false,
          msg:
            `Unknown bot: ${name}`
        });
      }

      await stopBot(state);

      return res.json({
        success: true,
        msg:
          `${name} stopped.`
      });
    }

    for (
      const state
      of STATES.values()
    ) {
      await stopBot(
        state
      );
    }

    res.json({
      success: true,
      msg:
        "All bots stopped."
    });
  }
);

// ============================================================
// DASHBOARD
// ============================================================

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    char =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );
}

app.get(
  "/",
  (req, res) => {
    const options =
      [...STATES.keys()]
        .map(
          name =>
            `<option value="${escapeHTML(
              name
            )}">${escapeHTML(
              name
            )}</option>`
        )
        .join("");

    const bots =
      [...STATES.values()]
        .map(
          state => {
            const skin =
              skins[state.name];

            return `
<div class="bot ${
              state.connected
                ? "online"
                : "offline"
            }">

<div class="top">
<b>${escapeHTML(
              state.name
            )}</b>

<span>
${
              state.connected
                ? "CONNECTED"
                : "OFFLINE"
            }
</span>
</div>

<div class="info">
Skin:
${escapeHTML(
              skin?.customName ||
              "Not configured"
            )}
</div>

<div class="buttons">

<button
onclick="action(
'/start',
'${escapeHTML(
              state.name
            )}'
)">
Start
</button>

<button
onclick="action(
'/stop',
'${escapeHTML(
              state.name
            )}'
)">
Stop
</button>

<button
onclick="command(
'/skin ${escapeHTML(
              state.name
            )}'
)">
Skin
</button>

<button
onclick="command(
'/restartBot ${escapeHTML(
              state.name
            )}'
)">
Restart
</button>

</div>

</div>
`;
          }
        )
        .join("");

    res.send(`
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Minecraft Bot Dashboard
</title>

<style>

*{
box-sizing:border-box;
}

body{
margin:0;
padding:24px;
background:#0d1117;
color:#e6edf3;
font-family:Arial,sans-serif;
}

main{
max-width:850px;
margin:auto;
}

.card{
background:#161b22;
border:1px solid #30363d;
border-radius:12px;
padding:18px;
margin-bottom:16px;
}

.bot{
border:1px solid #30363d;
border-radius:10px;
padding:14px;
margin-bottom:10px;
}

.online{
border-color:#238636;
}

.offline{
border-color:#da3633;
}

.top{
display:flex;
justify-content:space-between;
}

.top span{
color:#8b949e;
font-size:12px;
}

.info{
color:#8b949e;
font-size:13px;
margin-top:8px;
}

.buttons{
display:flex;
gap:8px;
flex-wrap:wrap;
margin-top:12px;
}

button,
select,
input{
background:#0d1117;
color:#e6edf3;
border:1px solid #30363d;
border-radius:8px;
padding:9px 12px;
}

button{
cursor:pointer;
}

button:hover{
background:#21262d;
}

.commandRow{
display:flex;
gap:8px;
}

select{
min-width:150px;
}

input{
flex:1;
}

#output{
margin-top:12px;
padding:12px;
border:1px solid #30363d;
border-radius:8px;
white-space:pre-wrap;
font-family:Consolas,monospace;
}

a{
color:#58a6ff;
}

</style>

</head>

<body>

<main>

<h1>
Minecraft Bot Dashboard
</h1>

<div class="card">

<h2>
Command
</h2>

<div class="commandRow">

<select id="bot">
<option value="">
Select bot
</option>

${options}

</select>

<input
id="commandInput"
placeholder="/say hi everyone"
>

<button onclick="runCommand()">
Run
</button>

</div>

<div class="buttons">

<button
onclick="command('/restartBots')">
Restart All Bots
</button>

<button
onclick="restartSelected()">
Restart Selected
</button>

</div>

<div id="output">
Ready.
</div>

</div>

<div class="card">

${bots}

</div>

<a href="/logs">
Logs
</a>

</main>

<script>

async function command(text){

const bot =
document.getElementById(
"bot"
).value;

await send(text,bot);

}

async function runCommand(){

const text =
document.getElementById(
"commandInput"
).value.trim();

if(!text)return;

const bot =
document.getElementById(
"bot"
).value;

await send(text,bot);

}

async function restartSelected(){

const bot =
document.getElementById(
"bot"
).value;

if(!bot){

document.getElementById(
"output"
).textContent =
"Select a bot first.";

return;

}

await send(
"/restartBot " + bot,
bot
);

}

async function send(
text,
bot
){

const output =
document.getElementById(
"output"
);

output.textContent =
"Running...";

try{

const response =
await fetch(
"/command",
{
method:"POST",

headers:{
"Content-Type":
"application/json"
},

body:
JSON.stringify({
command:text,
bot:bot
})
}
);

const data =
await response.json();

output.textContent =
data.msg ||
"Done.";

}catch(error){

output.textContent =
"Command failed.";

}

}

async function action(
url,
name
){

const output =
document.getElementById(
"output"
);

try{

const response =
await fetch(
url,
{
method:"POST",

headers:{
"Content-Type":
"application/json"
},

body:
JSON.stringify({
name:name
})
}
);

const data =
await response.json();

output.textContent =
data.msg ||
"Done.";

}catch(error){

output.textContent =
"Request failed.";

}

}

document
.getElementById(
"commandInput"
)
.addEventListener(
"keydown",
function(event){

if(
event.key ===
"Enter"
){

runCommand();

}

}
);

</script>

</body>

</html>
`);
  }
);

// ============================================================
// LOGS
// ============================================================

app.get(
  "/logs",
  (req, res) => {
    let logs = [];

    try {
      logs =
        getLogs() || [];
    } catch (_) {}

    res.send(`
<!doctype html>

<html>

<body
style="
background:#0d1117;
color:#e6edf3;
font-family:Consolas,monospace;
padding:20px;
">

<a href="/">
Dashboard
</a>

<h1>
Logs
</h1>

<pre>${logs
  .slice(-200)
  .map(escapeHTML)
  .join("\n")}</pre>

</body>

</html>
`);
  }
);

// ============================================================
// PROCESS ERRORS
// ============================================================

process.on(
  "uncaughtException",
  error => {
    const state =
      STATES.values()
        .next()
        .value;

    if (state) {
      recordError(
        state,
        error
      );
    } else {
      log(
        `[PROCESS] ${String(error)}`
      );
    }
  }
);

process.on(
  "unhandledRejection",
  reason => {
    const state =
      STATES.values()
        .next()
        .value;

    if (state) {
      recordError(
        state,
        reason
      );
    } else {
      log(
        `[PROCESS] ${String(reason)}`
      );
    }
  }
);

// ============================================================
// SERVER START
// ============================================================

const server =
  app.listen(
    WEB_PORT,
    "0.0.0.0",
    () => {
      log(
        `Dashboard listening on port ${WEB_PORT}.`
      );

      log(
        `[CONFIG] Found ${STATES.size} bot(s): ${[
          ...STATES.keys()
        ].join(", ")}`
      );

      /*
      IMPORTANT:
      Start bots 30 seconds apart.
      */

      [...STATES.values()]
        .forEach(
          (state, index) => {
            setTimeout(
              () => {
                if (
                  !shuttingDown
                ) {
                  startBot(
                    state
                  );
                }
              },
              index * 30000
            );
          }
        );
    }
  );

server.on(
  "error",
  error => {
    log(
      `[HTTP] Server error: ${
        error?.message ||
        error
      }`
    );
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  log(
    `Received ${signal}; shutting down.`
  );

  for (
    const state
    of STATES.values()
  ) {
    try {
      await stopBot(
        state
      );
    } catch (_) {}
  }

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(0);
    },
    5000
  ).unref();
}

process.once(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.once(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);