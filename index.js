"use strict";

const mineflayer = require("mineflayer");
const {
  Movements,
  pathfinder
} = require("mineflayer-pathfinder");
const express = require("express");
const https = require("https");

const {
  addLog,
  getLogs
} = require("./logger");

const config =
  require("./settings.json");

const app = express();

app.use(
  express.json({
    limit: "16kb"
  })
);

// ============================================================
// CONFIG
// ============================================================

const PORT =
  Number(process.env.PORT) || 5000;

const SERVER_HOST =
  config?.server?.ip ||
  "localhost";

const SERVER_PORT =
  Number(
    config?.server?.port
  ) || 25565;

const SERVER_VERSION =
  config?.server?.version ||
  undefined;

const AUTH_TYPE =
  config?.["bot-account"]?.type ||
  "offline";

const DEFAULT_PASSWORD =
  config?.["bot-account"]?.password ||
  "";

const MAX_ERRORS = 25;

let shuttingDown = false;

// ============================================================
// BOT NAMES
// ============================================================

if (!Array.isArray(config.bots)) {
  throw new Error(
    'settings.json must contain a "bots" array.'
  );
}

const botNames = [
  ...new Set(
    config.bots
      .map(name =>
        String(name).trim()
      )
      .filter(Boolean)
  )
];

if (!botNames.length) {
  throw new Error(
    'No bots configured.'
  );
}

// ============================================================
// STATE
// ============================================================

const states = new Map();

function createState(name) {
  return {
    name,

    bot: null,
    movements: null,

    connected: false,
    connecting: false,
    manualStop: false,

    generation: 0,

    movementTimer: null,
    lookTimer: null,
    jumpTimer: null,
    chatTimer: null,
    combatTimer: null,
    eatTimer: null,
    authTimer: null,
    reconnectTimer: null,

    reconnectAttempts: 0,
    eating: false,

    startTime: Date.now(),
    lastActivity: Date.now(),

    errors: []
  };
}

for (const name of botNames) {
  states.set(
    name,
    createState(name)
  );
}

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

function rememberError(
  state,
  error
) {
  const message =
    error instanceof Error
      ? (
          error.stack ||
          error.message
        )
      : String(error);

  state.errors.push({
    time: Date.now(),
    message:
      message.slice(
        0,
        2000
      )
  });

  if (
    state.errors.length >
    MAX_ERRORS
  ) {
    state.errors.splice(
      0,
      state.errors.length -
        MAX_ERRORS
    );
  }

  log(
    `[${state.name}] ${message}`
  );
}

function touch(state) {
  state.lastActivity =
    Date.now();
}

function uptime(state) {
  return Math.floor(
    (
      Date.now() -
      state.startTime
    ) / 1000
  );
}

function getState(name) {
  if (!name) return null;

  return (
    states.get(
      String(name)
    ) || null
  );
}

// ============================================================
// HTML
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

// ============================================================
// DISCORD
// ============================================================

function sendDiscord(
  state,
  event,
  message
) {
  try {
    if (
      !config.discord?.enabled
    ) {
      return;
    }

    if (
      !config.discord?.events?.[
        event
      ]
    ) {
      return;
    }

    const webhook =
      config.discord?.webhookUrl;

    if (!webhook) return;

    const url =
      new URL(webhook);

    const body =
      JSON.stringify({
        content:
          `[${state.name}] ${message}`
      });

    const request =
      https.request(
        {
          hostname:
            url.hostname,

          port:
            url.port || 443,

          path:
            url.pathname +
            url.search,

          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Content-Length":
              Buffer.byteLength(
                body
              )
          },

          timeout: 5000
        },
        response => {
          response.resume();
        }
      );

    request.on(
      "error",
      () => {}
    );

    request.write(body);
    request.end();
  } catch (_) {}
}

// ============================================================
// TIMER CLEANUP
// ============================================================

function clearTimers(state) {
  if (state.movementTimer) {
    clearTimeout(
      state.movementTimer
    );
    state.movementTimer = null;
  }

  if (state.lookTimer) {
    clearInterval(
      state.lookTimer
    );
    state.lookTimer = null;
  }

  if (state.jumpTimer) {
    clearInterval(
      state.jumpTimer
    );
    state.jumpTimer = null;
  }

  if (state.chatTimer) {
    clearInterval(
      state.chatTimer
    );
    state.chatTimer = null;
  }

  if (state.combatTimer) {
    clearInterval(
      state.combatTimer
    );
    state.combatTimer = null;
  }

  if (state.eatTimer) {
    clearInterval(
      state.eatTimer
    );
    state.eatTimer = null;
  }

  if (state.authTimer) {
    clearTimeout(
      state.authTimer
    );
    state.authTimer = null;
  }

  if (state.reconnectTimer) {
    clearTimeout(
      state.reconnectTimer
    );
    state.reconnectTimer = null;
  }
}

// ============================================================
// MOVEMENT
// ============================================================

function stopMovement(state) {
  if (state.movementTimer) {
    clearTimeout(
      state.movementTimer
    );

    state.movementTimer = null;
  }

  if (!state.bot) return;

  try {
    state.bot.clearControlStates();
  } catch (_) {}
}

function startCircleWalk(state) {
  stopMovement(state);

  if (
    !config.movement?.enabled ||
    !config.movement?.[
      "circle-walk"
    ]?.enabled
  ) {
    return;
  }

  const movement =
    config.movement[
      "circle-walk"
    ];

  const stepTime =
    Math.max(
      1000,
      Number(
        movement.speed
      ) || 2500
    );

  const turn =
    String(
      movement.turn ||
      "right"
    ).toLowerCase();

  function walkStep() {
    const bot =
      state.bot;

    if (
      !bot ||
      !state.connected ||
      state.manualStop ||
      shuttingDown
    ) {
      stopMovement(state);
      return;
    }

    try {
      bot.setControlState(
        "forward",
        true
      );

      state.movementTimer =
        setTimeout(
          async () => {
            state.movementTimer =
              null;

            if (
              !state.bot ||
              !state.connected ||
              state.manualStop
            ) {
              stopMovement(state);
              return;
            }

            try {
              bot.setControlState(
                "forward",
                false
              );

              if (
                bot.entity
              ) {
                const yaw =
                  Number(
                    bot.entity.yaw
                  ) || 0;

                const amount =
                  Math.PI / 2;

                const newYaw =
                  turn === "left"
                    ? yaw - amount
                    : yaw + amount;

                await bot.look(
                  newYaw,
                  0,
                  true
                );

                touch(state);
              }
            } catch (error) {
              rememberError(
                state,
                error
              );
            }

            state.movementTimer =
              setTimeout(
                walkStep,
                1000
              );
          },
          stepTime
        );
    } catch (error) {
      rememberError(
        state,
        error
      );

      state.movementTimer =
        setTimeout(
          walkStep,
          3000
        );
    }
  }

  walkStep();

  log(
    `[${state.name}] Anti-AFK movement enabled.`
  );
}

// ============================================================
// SNEAK
// ============================================================

function startSneak(state) {
  if (
    !config.utils?.[
      "anti-afk"
    ]?.sneak ||
    !state.bot
  ) {
    return;
  }

  try {
    state.bot.setControlState(
      "sneak",
      true
    );
  } catch (_) {}
}

// ============================================================
// LOOK
// ============================================================

function startLookAround(state) {
  if (
    !config.movement?.[
      "look-around"
    ]?.enabled
  ) {
    return;
  }

  const interval =
    Math.max(
      5000,
      Number(
        config.movement[
          "look-around"
        ].interval
      ) || 15000
    );

  state.lookTimer =
    setInterval(
      async () => {
        const bot =
          state.bot;

        if (
          !bot ||
          !state.connected ||
          !bot.entity
        ) {
          return;
        }

        try {
          const yaw =
            Number(
              bot.entity.yaw
            ) || 0;

          const change =
            (
              Math.random() -
              0.5
            ) *
            Math.PI;

          await bot.look(
            yaw + change,
            0,
            false
          );

          touch(state);
        } catch (_) {}
      },
      interval
    );
}

// ============================================================
// RANDOM JUMP
// ============================================================

function startRandomJump(state) {
  if (
    !config.movement?.[
      "random-jump"
    ]?.enabled
  ) {
    return;
  }

  const interval =
    Math.max(
      10000,
      Number(
        config.movement[
          "random-jump"
        ].interval
      ) || 30000
    );

  state.jumpTimer =
    setInterval(
      () => {
        const bot =
          state.bot;

        if (
          !bot ||
          !state.connected
        ) {
          return;
        }

        try {
          bot.setControlState(
            "jump",
            true
          );

          setTimeout(
            () => {
              if (
                state.bot !==
                bot
              ) {
                return;
              }

              try {
                bot.setControlState(
                  "jump",
                  false
                );
              } catch (_) {}
            },
            150
          );
        } catch (_) {}
      },
      interval
    );
}

// ============================================================
// AUTO AUTH
// ============================================================

function startAutoAuth(state) {
  const auth =
    config.utils?.[
      "auto-auth"
    ];

  if (
    !auth?.enabled ||
    !auth.password
  ) {
    return;
  }

  state.authTimer =
    setTimeout(
      () => {
        state.authTimer =
          null;

        if (
          !state.bot ||
          !state.connected
        ) {
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
          rememberError(
            state,
            error
          );
        }
      },
      2500
    );
}

// ============================================================
// REPEATED CHAT
// ============================================================

function startChatMessages(state) {
  const settings =
    config.utils?.[
      "chat-messages"
    ];

  if (
    !settings?.enabled ||
    !settings.repeat ||
    !Array.isArray(
      settings.messages
    ) ||
    !settings.messages.length
  ) {
    return;
  }

  const delay =
    Math.max(
      30000,
      Number(
        settings[
          "repeat-delay"
        ]
      ) || 120
    ) *
    1000;

  state.chatTimer =
    setInterval(
      () => {
        if (
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        try {
          const message =
            String(
              settings.messages[
                Math.floor(
                  Math.random() *
                    settings.messages.length
                )
              ]
            ).slice(
              0,
              256
            );

          state.bot.chat(
            message
          );

          touch(state);
        } catch (error) {
          rememberError(
            state,
            error
          );
        }
      },
      delay
    );
}

// ============================================================
// AUTO EAT
// ============================================================

const FOOD_NAMES =
  new Set([
    "bread",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_chicken",
    "cooked_mutton",
    "cooked_rabbit",
    "cooked_cod",
    "cooked_salmon",
    "baked_potato",
    "carrot",
    "golden_carrot",
    "apple",
    "melon_slice",
    "sweet_berries",
    "glow_berries",
    "beetroot",
    "potato",
    "pumpkin_pie",
    "cookie"
  ]);

async function tryEat(state) {
  if (
    state.eating ||
    !state.bot ||
    !state.connected
  ) {
    return;
  }

  if (
    !config.combat?.[
      "auto-eat"
    ]
  ) {
    return;
  }

  if (
    Number(
      state.bot.food
    ) > 12
  ) {
    return;
  }

  const food =
    state.bot.inventory
      .items()
      .find(
        item =>
          FOOD_NAMES.has(
            item.name
          )
      );

  if (!food) return;

  state.eating = true;

  try {
    await state.bot.equip(
      food,
      "hand"
    );

    await state.bot.consume();

    log(
      `[${state.name}] Ate ${food.name}.`
    );
  } catch (error) {
    rememberError(
      state,
      error
    );
  } finally {
    state.eating = false;
  }
}

function startAutoEat(state) {
  if (
    !config.combat?.[
      "auto-eat"
    ]
  ) {
    return;
  }

  state.eatTimer =
    setInterval(
      () => tryEat(state),
      10000
    );
}

// ============================================================
// COMBAT
// ============================================================

const HOSTILE_MOBS =
  new Set([
    "zombie",
    "skeleton",
    "spider",
    "creeper",
    "witch",
    "enderman",
    "drowned",
    "husk",
    "stray",
    "pillager",
    "vindicator",
    "ravager",
    "phantom",
    "silverfish",
    "cave_spider"
  ]);

function isHostileMob(entity) {
  if (
    !entity ||
    entity.type !== "mob" ||
    !entity.position
  ) {
    return false;
  }

  return HOSTILE_MOBS.has(
    String(
      entity.name || ""
    ).toLowerCase()
  );
}

function startCombat(state) {
  if (
    !config.modules?.combat ||
    !config.combat?.[
      "attack-mobs"
    ]
  ) {
    return;
  }

  const interval =
    Math.max(
      750,
      Number(
        config.combat[
          "attack-delay"
        ]
      ) || 1500
    );

  state.combatTimer =
    setInterval(
      () => {
        const bot =
          state.bot;

        if (
          !bot ||
          !state.connected ||
          !bot.entity
        ) {
          return;
        }

        try {
          const range =
            Number(
              config.combat[
                "attack-range"
              ]
            ) || 3.5;

          const target =
            bot.nearestEntity(
              entity => {
                if (
                  !isHostileMob(
                    entity
                  )
                ) {
                  return false;
                }

                return (
                  bot.entity.position.distanceTo(
                    entity.position
                  ) <= range
                );
              }
            );

          if (!target) return;

          bot.attack(
            target
          );

          touch(state);
        } catch (error) {
          rememberError(
            state,
            error
          );
        }
      },
      interval
    );
}

// ============================================================
// FEATURES
// ============================================================

function startFeatures(state) {
  startCircleWalk(state);
  startLookAround(state);
  startRandomJump(state);
  startChatMessages(state);
  startAutoEat(state);
  startCombat(state);
  startSneak(state);
  startAutoAuth(state);
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
    !config.utils?.[
      "auto-reconnect"
    ]
  ) {
    return;
  }

  const base =
    Math.max(
      15000,
      Number(
        config.utils[
          "auto-reconnect-delay"
        ]
      ) || 15000
    );

  const maximum =
    Math.max(
      base,
      Number(
        config.utils[
          "max-reconnect-delay"
        ]
      ) || 120000
    );

  const delay =
    Math.min(
      maximum,
      base *
        Math.pow(
          2,
          Math.min(
            state.reconnectAttempts,
            6
          )
        )
    );

  state.reconnectAttempts++;

  log(
    `[${state.name}] Reconnecting in ${Math.ceil(
      delay / 1000
    )}s${
      reason
        ? ` (${reason})`
        : ""
    }`
  );

  state.reconnectTimer =
    setTimeout(
      () => {
        state.reconnectTimer =
          null;

        if (
          !shuttingDown
        ) {
          startBot(state);
        }
      },
      delay
    );
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupBot(
  state,
  reason = "cleanup"
) {
  stopMovement(state);
  clearTimers(state);

  const bot =
    state.bot;

  state.bot = null;
  state.movements = null;
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
// EVENTS
// ============================================================

function registerEvents(
  state,
  bot,
  generation
) {
  bot.once(
    "login",
    () => {
      if (
        generation !==
        state.generation
      ) {
        return;
      }

      log(
        `[${state.name}] Logged in.`
      );
    }
  );

  bot.once(
    "spawn",
    () => {
      if (
        generation !==
          state.generation ||
        state.bot !== bot
      ) {
        return;
      }

      state.connected = true;
      state.reconnectAttempts = 0;
      state.startTime =
        Date.now();

      touch(state);

      log(
        `[${state.name}] Spawned successfully.`
      );

      try {
        state.movements =
          new Movements(
            bot
          );

        state.movements.canDig =
          false;

        state.movements.allow1by1towers =
          false;

        state.movements.allowFreeMotion =
          false;

        bot.pathfinder.setMovements(
          state.movements
        );
      } catch (error) {
        rememberError(
          state,
          error
        );

        log(
          `[${state.name}] Pathfinder warning: ${
            error?.message ||
            error
          }`
        );
      }

      if (
        config.performance?.[
          "disablePhysics"
        ]
      ) {
        bot.physicsEnabled =
          false;
      }

      startFeatures(state);

      sendDiscord(
        state,
        "connect",
        "Connected."
      );

      log(
        `[${state.name}] Features started.`
      );
    }
  );

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

      touch(state);

      if (
        config.utils?.[
          "chat-log"
        ]
      ) {
        log(
          `[${state.name}] <${username}> ${message}`
        );
      }

      if (
        config.discord?.events?.chat
      ) {
        sendDiscord(
          state,
          "chat",
          `<${username}> ${message}`
        );
      }

      if (
        !config.chat?.respond ||
        username === state.name
      ) {
        return;
      }

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
          state.bot.chat(
            `Hello ${username}!`
          );
        } catch (_) {}
      }
    }
  );

  bot.on(
    "whisper",
    (
      username,
      message
    ) => {
      if (
        config.utils?.[
          "chat-log"
        ]
      ) {
        log(
          `[${state.name}] [WHISPER] <${username}> ${message}`
        );
      }
    }
  );

  bot.on(
    "kicked",
    reason => {
      if (
        generation !==
        state.generation
      ) {
        return;
      }

      state.connected =
        false;

      let text;

      try {
        text =
          typeof reason ===
            "string"
            ? reason
            : JSON.stringify(
                reason
              );
      } catch (_) {
        text =
          String(reason);
      }

      log(
        `[${state.name}] Kicked: ${text}`
      );

      sendDiscord(
        state,
        "disconnect",
        `Kicked: ${text}`
      );
    }
  );

  bot.on(
    "error",
    error => {
      if (
        generation !==
        state.generation
      ) {
        return;
      }

      rememberError(
        state,
        error
      );
    }
  );

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

      sendDiscord(
        state,
        "disconnect",
        "Disconnected."
      );

      scheduleReconnect(
        state,
        "connection ended"
      );
    }
  );
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

  if (
    state.reconnectTimer
  ) {
    clearTimeout(
      state.reconnectTimer
    );

    state.reconnectTimer =
      null;
  }

  state.connecting = true;

  const generation =
    ++state.generation;

  try {
    log(
      `[${state.name}] Connecting to ${SERVER_HOST}:${SERVER_PORT}...`
    );

    const bot =
      mineflayer.createBot({
        host:
          SERVER_HOST,

        port:
          SERVER_PORT,

        username:
          state.name,

        auth:
          AUTH_TYPE,

        password:
          DEFAULT_PASSWORD ||
          undefined,

        version:
          SERVER_VERSION,

        viewDistance:
          2,

        physicsEnabled:
          config.performance?.[
            "disablePhysics"
          ]
            ? false
            : true,

        chatLog:
          false,

        checkTimeoutInterval:
          30000,

        connectTimeout:
          30000,

        hideErrors:
          false
      });

    state.bot = bot;

    bot.loadPlugin(
      pathfinder
    );

    registerEvents(
      state,
      bot,
      generation
    );

    return true;
  } catch (error) {
    state.bot = null;

    rememberError(
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

  clearTimers(state);

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
      msg:
        "Bot not found."
    };
  }

  stopBot(
    state
  ).finally(
    () => {
      if (
        shuttingDown
      ) {
        return;
      }

      setTimeout(
        () => {
          if (
            shuttingDown
          ) {
            return;
          }

          state.manualStop =
            false;

          startBot(
            state
          );
        },
        5000
      );
    }
  );

  return {
    success: true,
    msg:
      `${state.name} is restarting.`
  };
}

function restartAllBots() {
  const list =
    [...states.values()];

  Promise.all(
    list.map(
      state =>
        stopBot(state)
    )
  ).finally(
    () => {
      list.forEach(
        (state, index) => {
          setTimeout(
            () => {
              if (
                shuttingDown
              ) {
                return;
              }

              state.manualStop =
                false;

              startBot(
                state
              );
            },
            5000 +
              index *
                30000
          );
        }
      );
    }
  );

  return {
    success: true,
    msg:
      "All bots are restarting."
  };
}

// ============================================================
// COMMANDS
// ============================================================

function executeCommand(
  raw,
  selectedBot
) {
  const text =
    String(
      raw || ""
    ).trim();

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

  if (
    command ===
    "/restartbots"
  ) {
    return restartAllBots();
  }

  if (
    command ===
    "/restartbot"
  ) {
    const name =
      parts[1] ||
      selectedBot;

    if (!name) {
      return {
        success: false,
        msg:
          "Usage: /restartBot <BotName>"
      };
    }

    return restartBot(
      getState(name)
    );
  }

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
      states.has(
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
        .slice(
          0,
          256
        );

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

      touch(state);

      log(
        `[COMMAND] ${name}: ${message}`
      );

      return {
        success: true,
        msg:
          `${name}: ${message}`
      };
    } catch (error) {
      rememberError(
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

  if (
    command ===
    "/help"
  ) {
    return {
      success: true,
      msg:
        "/say <Bot> <message>\n" +
        "/restartBot <Bot>\n" +
        "/restartBots"
    };
  }

  return {
    success: false,
    msg:
      "Available: /say, /restartBot, /restartBots, /help"
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
        executeCommand(
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
        return res
          .status(404)
          .json({
            success: false,
            msg:
              `Unknown bot: ${name}`
          });
      }

      await startBot(
        state
      );

      return res.json({
        success: true,
        msg:
          `${name} start requested.`
      });
    }

    const list =
      [...states.values()];

    list.forEach(
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
          index *
            30000
        );
      }
    );

    res.json({
      success: true,
      msg:
        "Bots scheduled."
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
        return res
          .status(404)
          .json({
            success: false,
            msg:
              `Unknown bot: ${name}`
          });
      }

      await stopBot(
        state
      );

      return res.json({
        success: true,
        msg:
          `${name} stopped.`
      });
    }

    for (
      const state
      of states.values()
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

app.get(
  "/",
  (req, res) => {
    const options =
      [...states.keys()]
        .map(
          name =>
            `<option value="${escapeHTML(
              name
            )}">${escapeHTML(
              name
            )}</option>`
        )
        .join("");

    const cards =
      [...states.values()]
        .map(
          state => `
<div class="bot ${
            state.connected
              ? "online"
              : "offline"
          }">

<div class="top">

<b>
${escapeHTML(
            state.name
          )}
</b>

<span>
${
            state.connected
              ? "CONNECTED"
              : "OFFLINE"
          }
</span>

</div>

<div class="info">
Uptime:
${uptime(state)}s
</div>

<div class="buttons">

<button onclick="action(
'/start',
'${escapeHTML(
            state.name
          )}'
)">
Start
</button>

<button onclick="action(
'/stop',
'${escapeHTML(
            state.name
          )}'
)">
Stop
</button>

<button onclick="run(
'/restartBot ${escapeHTML(
            state.name
          )}'
)">
Restart
</button>

</div>

</div>
`
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
Minecraft AFK Bot Dashboard
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
font-size:12px;
color:#8b949e;
}

.info{
margin-top:8px;
font-size:13px;
color:#8b949e;
}

.row{
display:flex;
gap:8px;
}

select,
input,
button{
background:#0d1117;
color:#e6edf3;
border:1px solid #30363d;
border-radius:8px;
padding:9px 12px;
}

select{
min-width:160px;
}

input{
flex:1;
}

button{
cursor:pointer;
}

button:hover{
background:#21262d;
}

.buttons{
display:flex;
gap:8px;
flex-wrap:wrap;
margin-top:12px;
}

#output{
margin-top:12px;
padding:12px;
border:1px solid #30363d;
border-radius:8px;
white-space:pre-wrap;
font-family:Consolas,monospace;
min-height:45px;
}

a{
color:#58a6ff;
}

</style>

</head>

<body>

<main>

<h1>
Minecraft AFK Bot Dashboard
</h1>

<div class="card">

<h2>
Bot Commands
</h2>

<div class="row">

<select id="bot">

<option value="">
Select bot
</option>

${options}

</select>

<input
id="command"
placeholder="/say hi everyone"
>

<button onclick="runCommand()">
Run
</button>

</div>

<div class="buttons">

<button onclick="run('/restartBots')">
Restart All Bots
</button>

<button onclick="restartSelected()">
Restart Selected
</button>

</div>

<div id="output">
Ready.
</div>

</div>

<div class="card">

${cards}

</div>

<a href="/logs">
Logs
</a>

<script>

async function run(command){

const bot =
document.getElementById(
"bot"
).value;

await execute(
command,
bot
);

}

async function runCommand(){

const command =
document.getElementById(
"command"
).value.trim();

if(!command)return;

const bot =
document.getElementById(
"bot"
).value;

await execute(
command,
bot
);

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

await execute(
"/restartBot " + bot,
bot
);

}

async function execute(
command,
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
command,
bot
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
name
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
"command"
)
.addEventListener(
"keydown",
event => {

if(
event.key ===
"Enter"
){

runCommand();

}

}
);

</script>

</main>

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

<body style="
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
  .slice(-250)
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
      states.values()
        .next()
        .value;

    if (state) {
      rememberError(
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
      states.values()
        .next()
        .value;

    if (state) {
      rememberError(
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
// RAILWAY SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      log(
        `Dashboard listening on port ${PORT}.`
      );

      log(
        `[CONFIG] Found ${states.size} bot(s): ${[
          ...states.keys()
        ].join(", ")}`
      );

      /*
      Start bots one at a time.
      The next bot starts 30 seconds after
      the previous one successfully spawns.
      */

      const list =
        [...states.values()];

      if (list.length) {
        startBot(
          list[0]
        );

        let nextIndex = 1;

        const watcher =
          setInterval(
            () => {

              if (
                shuttingDown ||
                nextIndex >=
                  list.length
              ) {
                clearInterval(
                  watcher
                );
                return;
              }

              const previous =
                list[
                  nextIndex - 1
                ];

              const next =
                list[
                  nextIndex
                ];

              if (
                previous.connected &&
                !next.bot &&
                !next.connecting
              ) {

                log(
                  `[STARTUP] ${previous.name} is online. Starting ${next.name} in 30s.`
                );

                setTimeout(
                  () => {

                    if (
                      !shuttingDown &&
                      !next.bot &&
                      !next.connecting
                    ) {
                      startBot(
                        next
                      );
                    }

                  },
                  30000
                );

                nextIndex++;
              }

            },
            3000
          );
      }
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
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  log(
    `Received ${signal}; shutting down.`
  );

  for (
    const state
    of states.values()
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
