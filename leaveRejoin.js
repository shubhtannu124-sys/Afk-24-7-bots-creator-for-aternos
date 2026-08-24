"use strict";

function randomMs(minMs, maxMs) {
    return Math.floor(
        Math.random() * (maxMs - minMs + 1)
    ) + minMs;
}

function setupLeaveRejoin(bot, createBot) {
    let leaveTimer = null;
    let jumpTimer = null;
    let jumpOffTimer = null;
    let reconnectTimer = null;

    let stopped = false;
    let reconnecting = false;
    let reconnectAttempts = 0;
    let lastLogAt = 0;

    function logThrottled(
        message,
        minGapMs = 3000
    ) {
        const now = Date.now();

        if (
            now - lastLogAt >=
            minGapMs
        ) {
            lastLogAt = now;
            console.log(message);
        }
    }

    function clearTimers() {
        if (leaveTimer) {
            clearTimeout(leaveTimer);
            leaveTimer = null;
        }

        if (jumpTimer) {
            clearTimeout(jumpTimer);
            jumpTimer = null;
        }

        if (jumpOffTimer) {
            clearTimeout(jumpOffTimer);
            jumpOffTimer = null;
        }

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }

    function stop() {
        stopped = true;
        reconnecting = false;
        clearTimers();

        try {
            bot.clearControlStates();
        } catch (_) {}
    }

    function scheduleNextJump() {
        if (
            stopped ||
            !bot ||
            !bot.entity
        ) {
            return;
        }

        try {
            bot.setControlState(
                "jump",
                true
            );

            jumpOffTimer =
                setTimeout(() => {
                    jumpOffTimer = null;

                    try {
                        if (
                            !stopped &&
                            bot
                        ) {
                            bot.setControlState(
                                "jump",
                                false
                            );
                        }
                    } catch (_) {}
                }, 200);
        } catch (_) {}

        const nextJump =
            randomMs(
                30000,
                300000
            );

        jumpTimer =
            setTimeout(
                () => {
                    jumpTimer = null;
                    scheduleNextJump();
                },
                nextJump
            );
    }

    function scheduleReconnect(reason) {
        if (
            stopped ||
            reconnecting ||
            !createBot
        ) {
            return;
        }

        reconnecting = true;
        reconnectAttempts++;

        /*
        Never reconnect immediately.
        This prevents Aternos connection throttling.
        */

        const delay = Math.min(
            120000,
            30000 *
                Math.pow(
                    2,
                    Math.min(
                        reconnectAttempts - 1,
                        2
                    )
                )
        );

        logThrottled(
            `[AFK] Rejoin scheduled in ${
                Math.ceil(delay / 1000)
            }s (${reason})`
        );

        reconnectTimer =
            setTimeout(() => {
                reconnectTimer = null;

                if (stopped) {
                    reconnecting = false;
                    return;
                }

                try {
                    createBot();
                } catch (error) {
                    reconnecting = false;

                    console.log(
                        "[AFK] createBot error:",
                        error?.message ||
                            error
                    );

                    scheduleReconnect(
                        "createBot-error"
                    );
                }
            }, delay);
    }

    bot.once(
        "spawn",
        () => {
            stopped = false;
            reconnecting = false;
            reconnectAttempts = 0;

            clearTimers();

            /*
            Leave after ~16 minutes.
            Your main index.js can also handle reconnecting.
            */

            const stayTime =
                1000 * 1000;

            logThrottled(
                `[AFK] Will leave in ${
                    stayTime / 1000
                } seconds.`
            );

            scheduleNextJump();

            leaveTimer =
                setTimeout(() => {
                    leaveTimer = null;

                    if (stopped) {
                        return;
                    }

                    logThrottled(
                        "[AFK] Leave timer reached."
                    );

                    try {
                        bot.quit(
                            "AFK cycle"
                        );
                    } catch (_) {}
                }, stayTime);
        }
    );

    bot.once(
        "end",
        () => {
            if (stopped) {
                return;
            }

            clearTimers();

            reconnecting = false;

            scheduleReconnect(
                "disconnected"
            );
        }
    );

    bot.once(
        "kicked",
        reason => {
            if (stopped) {
                return;
            }

            clearTimers();

            reconnecting = false;

            console.log(
                `[AFK] Bot was kicked: ${reason}`
            );

            scheduleReconnect(
                "kicked"
            );
        }
    );

    bot.on(
        "error",
        error => {
            if (stopped) {
                return;
            }

            console.log(
                `[AFK] Connection error: ${
                    error?.message ||
                    error
                }`
            );

            /*
            Do not immediately reconnect here.
            Mineflayer normally emits "end" after
            the connection closes.
            */

        }
    );

    return {
        stop
    };
}

module.exports =
    setupLeaveRejoin;
