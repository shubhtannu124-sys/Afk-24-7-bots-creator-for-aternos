function randomMs(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

function setupLeaveRejoin(bot, createBot) {
    // Timers
    let leaveTimer = null
    let jumpTimer = null
    let jumpOffTimer = null
    let reconnectTimer = null

    // State
    let stopped = false
    let reconnectAttempts = 0
    let lastLogAt = 0

    function logThrottled(msg, minGapMs = 2000) {
        const now = Date.now()
        if (now - lastLogAt >= minGapMs) {
            lastLogAt = now
            console.log(msg)
        }
    }

    function cleanup() {
        stopped = true
        if (leaveTimer) clearTimeout(leaveTimer)
        if (jumpTimer) clearTimeout(jumpTimer)
        if (jumpOffTimer) clearTimeout(jumpOffTimer)
        if (reconnectTimer) clearTimeout(reconnectTimer)
        leaveTimer = jumpTimer = jumpOffTimer = reconnectTimer = null
    }

    function scheduleNextJump() {
        if (stopped || !bot.entity) return

        bot.setControlState('jump', true)
        jumpOffTimer = setTimeout(() => {
            bot.setControlState('jump', false)
        }, 300)

        // random jump 20s -> 5m
        const nextJump = randomMs(20000, 5 * 60 * 1000)
        jumpTimer = setTimeout(scheduleNextJump, nextJump)
    }

    function scheduleReconnect(reason) {
        if (stopped) return

        // Fast reconnect: 1 second delay
        let delay = 1000 

        reconnectAttempts++
        if (reconnectAttempts > 3) {
            delay += 5000 // Add a 5s delay only if it fails repeatedly
        }

        logThrottled(`[AFK] Rejoin scheduled in ${delay / 1000}s (reason: ${reason}, attempt: ${reconnectAttempts})`)

        reconnectTimer = setTimeout(() => {
            if (stopped) return
            try {
                if (typeof createBot === 'function') createBot()
            } catch (e) {
                console.log('[AFK] createBot error:', e?.message || e)
                scheduleReconnect('createBot-error')
            }
        }, delay)
    }

    bot.once('spawn', () => {
        reconnectAttempts = 0
        cleanup()
        stopped = false

        // 1000 seconds exactly
        const stayTime = 1000 * 1000 

        logThrottled(`[AFK] Will leave in ${stayTime / 1000} seconds to prevent AFK ban`)

        scheduleNextJump()

        leaveTimer = setTimeout(() => {
            if (stopped) return
            logThrottled('[AFK] 1000 seconds reached. Leaving server.')
            cleanup()
            try {
                bot.quit()
            } catch (e) {
                // ignore if already closed
            }
        }, stayTime)
    })

    bot.on('end', () => {
        cleanup()
        stopped = false // Reset stopped to allow scheduleReconnect to run
        scheduleReconnect('disconnected')
    })

    bot.on('kicked', (reason) => {
        cleanup()
        stopped = false // Reset stopped to allow scheduleReconnect to run
        console.log(`[AFK] Bot was kicked! Reason: ${reason}`)
        scheduleReconnect('kicked')
    })

    bot.on('error', (err) => {
        cleanup()
        stopped = false // Reset stopped to allow scheduleReconnect to run
        console.log(`[AFK] Connection Error: ${err}`)
        scheduleReconnect('error')
    })
}

module.exports = setupLeaveRejoin
