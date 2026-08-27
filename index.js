```javascript
"use strict";

const express = require("express");
const https = require("https");
const mineflayer = require("mineflayer");
const { Movements, pathfinder } = require("mineflayer-pathfinder");

const { addLog, getLogs } = require("./logger");
const config = require("./settings.json");

const app = express();
app.use(express.json({ limit: "16kb" }));

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT) || 5000;
const SERVER_HOST = String(config?.server?.ip || "localhost");
const SERVER_PORT = Number(config?.server?.port) || 25565;
const SERVER_VERSION = String(config?.server?.version || "1.20.1");

const AUTH_TYPE =
  String(config?.["bot-account"]?.type || "offline");

const AUTH_PASSWORD =
  String(config?.["bot-account"]?.password || "");

const LEAVE_AFTER_MS = 1000 * 1000;
const PLANNED_RECONNECT_MS = 15000;

let shuttingDown = false;

// ============================================================
// BOT LIST
// ============================================================

if (!Array.isArray(config.bots) || config.bots.length === 0) {
  throw new Error(
    'settings.json must contain a non-empty "bots" array.'
  );
}

const botNames = [
  ...new Set(
    config.bots
      .map(name => String(name).trim())
      .filter(Boolean)
  )
];

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
    reconnectAttempts: 0,
    eating: false,

    timers: {
      leave: null,
      movement: null,
      look: null,
      jump: null,
      chat: null,
      combat: null,
      eat: null,
      auth: null,
      reconnect: null
    },

    startedAt: Date.now(),
    lastActivity: Date.now(),
    errors: []
  };
}

for (const name of botNames) {
  states.set(name, createState(name));
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

function rememberError(state, error) {
  const message =
    error instanceof Error
      ? error.stack || error.message
      : String(error);

  state.errors.push({
    time: Date.now(),
    message: message.slice(0, 2000)
  });

  if (state.errors.length > 25) {
    state.errors.shift();
  }

  log(`[${state.name}] ${message}`);
}

function touch(state) {
  state.lastActivity = Date.now();
}

function uptime(state) {
  return Math.floor(
    (Date.now() - state.startedAt) / 1000
  );
}

function getState(name) {
  if (!name) return null;

  return states.get(String(name)) || null;
}

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

function sendDiscord(state, event, message) {
  try {
    if (!config.discord?.enabled) return;
    if (!config.discord?.events?.[event]) return;

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

    request.end(body);
  } catch (_) {}
}

// ============================================================
// TIMER HELPERS
// ============================================================

function clearTimer(state, name) {
  const timer =
    state.timers[name];

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  clearInterval(timer);

  state.timers[name] = null;
}

function clearTimers(state) {
  for (
    const name
    of Object.keys(state.timers)
  ) {
    clearTimer(
      state,
      name
    );
  }
}

// ============================================================
// MOVEMENT
// ============================================================

function stopMovement(state) {
  clearTimer(
    state,
    "movement"
  );

  if (!state.bot) {
    return;
  }

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

  const settings =
    config.movement[
      "circle-walk"
    ];

  const stepTime =
    Math.max(
      1000,
      Number(
        settings.speed
      ) || 2500
    );

  const turningLeft =
    String(
      settings.turn ||
      "right"
    ).toLowerCase() === "left";

  const walkStep =
    async () => {
      const bot =
        state.bot;

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

        state.timers.movement =
          setTimeout(
            async () => {
              state.timers.movement =
                null;

              if (
                !state.bot ||
                !state.connected ||
                state.manualStop
              ) {
                stopMovement(
                  state
                );
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

                  await bot.look(
                    yaw +
                      (
                        turningLeft
                          ? -Math.PI / 2
                          : Math.PI / 2
                      ),
                    0,
                    true
                  );

                  touch(
                    state
                  );
                }
              } catch (
                error
              ) {
                rememberError(
                  state,
                  error
                );
              }

              state.timers.movement =
                setTimeout(
                  walkStep,
                  1000
                );
            },
            stepTime
          );
      } catch (
        error
      ) {
        rememberError(
          state,
          error
        );

        state.timers.movement =
          setTimeout(
            walkStep,
            3000
          );
      }
    };

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

  state.timers.look =
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

          touch(
            state
          );
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

  state.timers.jump =
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
              try {
                if (
                  state.bot ===
                  bot
                ) {
                  bot.setControlState(
                    "jump",
                    false
                  );
                }
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
  const settings =
    config.utils?.[
      "auto-auth"
    ];

  if (
    !settings?.enabled ||
    !settings.password
  ) {
    return;
  }

  state.timers.auth =
    setTimeout(
      () => {
        state.timers.auth =
          null;

        if (
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        try {
          state.bot.chat(
            `/login ${settings.password}`
          );

          log(
            `[${state.name}] Auto-auth command sent.`
          );
        } catch (
          error
        ) {
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

  const interval =
    Math.max(
      30000,
      Number(
        settings[
          "repeat-delay"
        ]
      ) || 120
    ) * 1000;

  state.timers.chat =
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

          touch(
            state
          );
        } catch (
          error
        ) {
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
    !config.combat?.[
      "auto-eat"
    ] ||
    state.eating ||
    !state.bot ||
    !state.connected
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

  if (!food) {
    return;
  }

  state.eating = true;

  try {
    await state.bot.equip(
      food,
      "hand"
    );

    await state.bot.consume();

    touch(
      state
    );

    log(
      `[${state.name}] Ate ${food.name}.`
    );
  } catch (
    error
  ) {
    rememberError(
      state,
      error
    );
  } finally {
    state.eating =
      false;
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

  state.timers.eat =
    setInterval(
      () =>
        tryEat(
          state
        ),
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

  state.timers.combat =
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
                  ) <=
                  range
                );
              }
            );

          if (
            target
          ) {
            bot.attack(
              target
            );

            touch(
              state
            );
          }
        } catch (
          error
        ) {
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
// PLANNED 1000 SECOND REJOIN
// ============================================================

function schedulePlannedRejoin(state) {
  clearTimer(
    state,
    "leave"
  );

  state.timers.leave =
    setTimeout(
      () => {
        state.timers.leave =
          null;

        if (
          shuttingDown ||
          state.manualStop ||
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        log(
          `[${state.name}] 1000 seconds reached. Leaving for planned rejoin.`
        );

        state.connected =
          false;

        try {
          state.bot.clearControlStates();
        } catch (_) {}

        try {
          state.bot.quit(
            "planned AFK rejoin"
          );
        } catch (
          error
        ) {
          rememberError(
            state,
            error
          );

          cleanupBot(
            state,
            "planned rejoin cleanup"
          );

          schedulePlannedReconnect(
            state
          );
        }
      },
      LEAVE_AFTER_MS
    );
}

function schedulePlannedReconnect(state) {
  if (
    shuttingDown ||
    state.manualStop ||
    state.bot ||
    state.connecting ||
    state.timers.reconnect
  ) {
    return;
  }

  log(
    `[${state.name}] Planned rejoin in ${Math.ceil(
      PLANNED_RECONNECT_MS /
        1000
    )}s.`
  );

  state.timers.reconnect =
    setTimeout(
      () => {
        state.timers.reconnect =
          null;

        if (
          shuttingDown ||
          state.manualStop ||
          state.bot ||
          state.connecting
        ) {
          return;
        }

        state.reconnectAttempts =
          0;

        startBot(
          state
        );
      },
      PLANNED_RECONNECT_MS
    );
}

// ============================================================
// NORMAL RECONNECT
// ============================================================

function scheduleReconnect(
  state,
  reason
) {
  if (
    shuttingDown ||
    state.manualStop ||
    state.bot ||
    state.connecting ||
    state.timers.reconnect ||
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
      delay /
        1000
    )}s${
      reason
        ? ` (${reason})`
        : ""
    }`
  );

  state.timers.reconnect =
    setTimeout(
      () => {
        state.timers.reconnect =
          null;

        if (
          !shuttingDown
        ) {
          startBot(
            state
          );
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
  reason
) {
  clearTimers(
    state
  );

  const bot =
    state.bot;

  state.bot =
    null;

  state.movements =
    null;

  state.connected =
    false;

  state.connecting =
    false;

  if (!bot) {
    return;
  }

  try {
    bot.clearControlStates();
  } catch (_) {}

  try {
    bot.quit(
      reason ||
        "cleanup"
    );
  } catch (_) {}

  try {
    bot._client?.socket?.destroy();
  } catch (_) {}
}

// ============================================================
// BOT EVENTS
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
        state.bot !==
          bot
      ) {
        return;
      }

      state.connected =
        true;

      state.connecting =
        false;

      state.reconnectAttempts =
        0;

      state.startedAt =
        Date.now();

      touch(
        state
      );

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
      } catch (
        error
      ) {
        rememberError(
          state,
          error
        );
      }

      startCircleWalk(
        state
      );

      startLookAround(
        state
      );

      startRandomJump(
        state
      );

      startChatMessages(
        state
      );

      startAutoEat(
        state
      );

      startCombat(
        state
      );

      startSneak(
        state
      );

      startAutoAuth(
        state
      );

      schedulePlannedRejoin(
        state
      );

      sendDiscord(
        state,
        "connect",
        "Connected."
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

      touch(
        state
      );

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
        username ===
          state.name
      ) {
        return;
      }

      const text =
        String(
          message
        )
          .toLowerCase()
          .trim();

      if (
        text ===
          "hi" ||
        text ===
          "hello" ||
        text ===
          "hey"
      ) {
        try {
          bot.chat(
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

      state.connected =
        false;

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

      const planned =
        String(
          reason || ""
        )
          .toLowerCase()
          .includes(
            "planned afk rejoin"
          );

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
        planned
          ? "Planned AFK rejoin."
          : "Disconnected."
      );

      if (
        shuttingDown ||
        state.manualStop
      ) {
        return;
      }

      if (planned) {
        schedulePlannedReconnect(
          state
        );
      } else {
        scheduleReconnect(
          state,
          "connection ended"
        );
      }
    }
  );
}

// ============================================================
// START BOT
// ============================================================

async function startBot(
  state
) {
  if (
    shuttingDown ||
    state.bot ||
    state.connecting
  ) {
    return false;
  }

  state.manualStop =
    false;

  clearTimer(
    state,
    "reconnect"
  );

  clearTimer(
    state,
    "leave"
  );

  state.connecting =
    true;

  const generation =
    ++state.generation;

  try {
    log(
      `[${state.name}] Connecting to ${SERVER_HOST}:${SERVER_PORT} using Minecraft ${SERVER_VERSION}...`
    );

    const bot =
      mineflayer.createBot(
        {
          host:
            SERVER_HOST,

          port:
            SERVER_PORT,

          username:
            state.name,

          auth:
            AUTH_TYPE,

          password:
            AUTH_PASSWORD ||
            undefined,

          version:
            SERVER_VERSION,

          viewDistance:
            2,

          chatLog:
            false,

          checkTimeoutInterval:
            30000,

          connectTimeout:
            30000,

          hideErrors:
            false
        }
      );

    state.bot =
      bot;

    bot.loadPlugin(
      pathfinder
    );

    registerEvents(
      state,
      bot,
      generation
    );

    return true;
  } catch (
    error
  ) {
    state.bot =
      null;

    state.connecting =
      false;

    rememberError(
      state,
      error
    );

    scheduleReconnect(
      state,
      "start failed"
    );

    return false;
  }
}

// ============================================================
// STOP / RESTART
// ============================================================

async function stopBot(
  state
) {
  if (!state) {
    return;
  }

  state.manualStop =
    true;

  state.generation++;

  cleanupBot(
    state,
    "dashboard stop"
  );

  state.reconnectAttempts =
    0;

  log(
    `[${state.name}] Stopped.`
  );
}

function restartBot(
  state
) {
  if (!state) {
    return {
      success:
        false,

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
    success:
      true,

    msg:
      `${state.name} is restarting.`
  };
}

function restartAllBots() {
  const list =
    [
      ...states.values()
    ];

  Promise.all(
    list.map(
      state =>
        stopBot(
          state
        )
    )
  ).finally(
    () => {
      list.forEach(
        (
          state,
          index
        ) => {
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
    success:
      true,

    msg:
      "All bots are restarting."
  };
}

// ============================================================
// /BOTS COMMAND
// ============================================================

function executeBotsCommand(
  raw
) {
  const text =
    String(
      raw || ""
    ).trim();

  if (!text) {
    return {
      success:
        false,

      msg:
        "Usage: /bots <BotName> <command>"
    };
  }

  const parts =
    text.split(
      /\s+/
    );

  const botName =
    parts.shift();

  const command =
    parts
      .join(" ")
      .trim();

  if (
    !botName ||
    !command
  ) {
    return {
      success:
        false,

      msg:
        "Usage: /bots <BotName> <command>"
    };
  }

  if (
    botName.toLowerCase() ===
    "all"
  ) {
    if (
      command.toLowerCase() ===
        "/restart" ||
      command.toLowerCase() ===
        "restart"
    ) {
      return restartAllBots();
    }

    return {
      success:
        false,

      msg:
        "Use /bots all /restart for all bots."
    };
  }

  const state =
    getState(
      botName
    );

  if (!state) {
    return {
      success:
        false,

      msg:
        `Unknown bot: ${botName}`
    };
  }

  if (
    command.toLowerCase() ===
      "/restart" ||
    command.toLowerCase() ===
      "restart"
  ) {
    return restartBot(
      state
    );
  }

  if (
    !state.bot ||
    !state.connected
  ) {
    return {
      success:
        false,

      msg:
        `${state.name} is not connected.`
    };
  }

  try {
    state.bot.chat(
      command
    );

    touch(
      state
    );

    log(
      `[BOTS COMMAND] ${state.name} <- ${command}`
    );

    return {
      success:
        true,

      msg:
        `${state.name}: ${command}`
    };
  } catch (
    error
  ) {
    rememberError(
      state,
      error
    );

    return {
      success:
        false,

      msg:
        `${state.name}: command failed.`
    };
  }
}

// ============================================================
// COMMAND ROUTER
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
      success:
        false,

      msg:
        "Enter a command."
    };
  }

  const lower =
    text.toLowerCase();

  if (
    lower ===
    "/restartbots"
  ) {
    return restartAllBots();
  }

  if (
    lower ===
    "/help"
  ) {
    return {
      success:
        true,

      msg:
        "/bots <BotName> <command>\n" +
        "/bots all /restart"
    };
  }

  if (
    lower.startsWith(
      "/bots "
    )
  ) {
    return executeBotsCommand(
      text.slice(
        6
      )
    );
  }

  if (
    lower.startsWith(
      "/restartbot"
    )
  ) {
    return restartBot(
      getState(
        text.split(
          /\s+/
        )[1] ||
          selectedBot
      )
    );
  }

  return {
    success:
      false,

    msg:
      "Use: /bots <BotName> <command>"
  };
}

// ============================================================
// API
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
    } catch (
      error
    ) {
      res.status(
        500
      ).json({
        success:
          false,

        msg:
          String(
            error
          )
      });
    }
  }
);

app.post(
  "/start",
  async (
    req,
    res
  ) => {
    const name =
      req.body?.name;

    if (name) {
      const state =
        getState(
          name
        );

      if (!state) {
        return res
          .status(
            404
          )
          .json({
            success:
              false,

            msg:
              `Unknown bot: ${name}`
          });
      }

      await startBot(
        state
      );

      return res.json({
        success:
          true,

        msg:
          `${name} start requested.`
      });
    }

    [
      ...states.values()
    ].forEach(
      (
        state,
        index
      ) => {
        setTimeout(
          () =>
            startBot(
              state
            ),
          index *
            30000
        );
      }
    );

    res.json({
      success:
        true,

      msg:
        "Bots scheduled."
    });
  }
);

app.post(
  "/stop",
  async (
    req,
    res
  ) => {
    const name =
      req.body?.name;

    if (name) {
      const state =
        getState(
          name
        );

      if (!state) {
        return res
          .status(
            404
          )
          .json({
            success:
              false,

            msg:
              `Unknown bot: ${name}`
          });
      }

      await stopBot(
        state
      );

      return res.json({
        success:
          true,

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
      success:
        true,

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
  (
    req,
    res
  ) => {
    const options =
      [
        ...states.keys()
      ]
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
      [
        ...states.values()
      ]
        .map(
          state =>
            `
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
${uptime(
              state
            )}s
</div>

<div class="buttons">

<button onclick="pickBot(
'${escapeHTML(
              state.name
            )}'
)">
Select
</button>

<button onclick="run(
'/bots ${escapeHTML(
              state.name
            )} /restart'
)">
Restart
</button>

</div>

</div>
`
        )
        .join("");

    res.send(
      `
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
font-size:12px;
color:#8b949e;
}

.info{
margin-top:8px;
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

.help{
margin-top:12px;
color:#8b949e;
font-family:Consolas,monospace;
white-space:pre-wrap;
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
Bot Command Console
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
placeholder="/bots ChowminBot /say hi everyone"
>

<button onclick="runCommand()">
Run
</button>

</div>

<div class="help">
/bots &lt;BotName&gt; &lt;command&gt;

/bots ChowminBot /say hi everyone
/bots Samosa /restart
/bots Dahi /say hello
/bots all /restart
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

function pickBot(name){

document.getElementById(
"bot"
).value = name;

const input =
document.getElementById(
"command"
);

input.value =
"/bots " +
name +
" /say ";

input.focus();

}

async function run(
command
){

await send(
command
);

}

async function runCommand(){

const input =
document.getElementById(
"command"
);

const command =
input.value.trim();

if(
!command
){
return;
}

await send(
command
);

}

async function send(
command
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
method:
"POST",

headers:{
"Content-Type":
"application/json"
},

body:
JSON.stringify({
command:
command,

bot:
document.getElementById(
"bot"
).value
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
`
    );
  }
);

// ============================================================
// LOG PAGE
// ============================================================

app.get(
  "/logs",
  (
    req,
    res
  ) => {
    let logs = [];

    try {
      logs =
        getLogs() || [];
    } catch (_) {}

    res.send(
      `
<!doctype html>

<html>

<body style="
background:#0d1117;
color:#e6edf3;
font-family:Consolas,monospace;
padding:20px;
">

<a href="/" style="color:#58a6ff">
Dashboard
</a>

<h1>
Logs
</h1>

<pre>${logs
  .slice(
    -300
  )
  .map(
    escapeHTML
  )
  .join(
    "\n"
  )}</pre>

</body>

</html>
`
    );
  }
);

// ============================================================
// PROCESS ERRORS
// ============================================================

process.on(
  "uncaughtException",
  error => {
    log(
      `[PROCESS] ${
        error?.stack ||
        error
      }`
    );
  }
);

process.on(
  "unhandledRejection",
  reason => {
    log(
      `[PROCESS] ${
        reason?.stack ||
        reason
      }`
    );
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

      [
        ...states.values()
      ].forEach(
        (
          state,
          index
        ) => {
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
            index *
              30000
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

async function shutdown(
  signal
) {
  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

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
      process.exit(
        0
      );
    }
  );

  setTimeout(
    () => {
      process.exit(
        0
      );
    },
    5000
  ).unref();
}

process.once(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.once(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);
```
