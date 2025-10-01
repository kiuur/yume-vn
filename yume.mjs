import baileys from "@whiskeysockets/baileys";
const {
    default: makeWASocket,
    jidDecode,
    getContentType,
    makeInMemoryStore,
    useMultiFileAuthState,
    downloadContentFromMessage,
    DisconnectReason,
    proto
} = baileys;

import pino from "pino";
import readline from "readline";
import { Boom } from '@hapi/boom';
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import fs from "fs";

const ff = ffmpeg;

const question = (text) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        rl.question(text, resolve);
    });
};

const store = makeInMemoryStore({
    logger: pino().child({
        level: "fatal"
    })
});

function smsg(client, m, store) {
    if (!m) return m;
    let M = proto.WebMessageInfo;
    if (m.key) {
        m.id = m.key.id;
        m.isBaileys = m.id.startsWith('BAE5') && m.id.length === 16;
        m.chat = m.key.remoteJid;
        m.fromMe = m.key.fromMe;
        m.isGroup = m.chat.endsWith('@g.us');
        m.sender = client.decodeJid(m.fromMe && client.user.id || m.participant || m.key.participant || m.chat || '');
        if (m.isGroup) m.participant = client.decodeJid(m.key.participant) || '';
    }
    if (m.message) {
        m.mtype = getContentType(m.message);
        m.msg = (m.mtype == 'viewOnceMessage' ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)] : m.message[m.mtype]);
        m.body = m.message.conversation || m.msg.caption || m.msg.text || (m.mtype == 'listResponseMessage') && m.msg.singleSelectReply.selectedRowId || (m.mtype == 'buttonsResponseMessage') && m.msg.selectedButtonId || (m.mtype == 'viewOnceMessage') && m.msg.caption || m.text;
        let quoted = m.quoted = m.msg.contextInfo ? m.msg.contextInfo.quotedMessage : null;
        m.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
        if (m.quoted) {
            let type = getContentType(quoted);
            m.quoted = m.quoted[type];
            if (['productMessage'].includes(type)) {
                type = getContentType(m.quoted);
                m.quoted = m.quoted[type];
            }
            if (typeof m.quoted === 'string') m.quoted = {
                text: m.quoted
            };
            m.quoted.mtype = type;
            m.quoted.id = m.msg.contextInfo.stanzaId;
            m.quoted.chat = m.msg.contextInfo.remoteJid || m.chat;
            m.quoted.isBaileys = m.quoted.id ? m.quoted.id.startsWith('BAE5') && m.quoted.id.length === 16 : false;
            m.quoted.sender = client.decodeJid(m.msg.contextInfo.participant);
            m.quoted.fromMe = m.quoted.sender === client.decodeJid(client.user.id);
            m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || '';
            m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : [];
            m.getQuotedObj = m.getQuotedMessage = async () => {
                if (!m.quoted.id) return false;
                let q = await store.loadMessage(m.chat, m.quoted.id, client);
                return smsg(client, q, store);
            };
            let vM = m.quoted.fakeObj = M.fromObject({
                key: {
                    remoteJid: m.quoted.chat,
                    fromMe: m.quoted.fromMe,
                    id: m.quoted.id
                },
                message: quoted,
                ...(m.isGroup ? { participant: m.quoted.sender } : {})
            });
            m.quoted.delete = () => client.sendMessage(m.quoted.chat, { delete: vM.key });
            m.quoted.copyNForward = (jid, forceForward = false, options = {}) => client.copyNForward(jid, vM, forceForward, options);
            m.quoted.download = () => client.downloadMediaMessage(m.quoted);
        }
    }
    if (m.msg.url) m.download = () => client.downloadMediaMessage(m.msg);
    m.text = m.msg.text || m.msg.caption || m.message.conversation || m.msg.contentText || m.msg.selectedDisplayText || m.msg.title || '';
    m.reply = (text, chatId = m.chat, options = {}) => Buffer.isBuffer(text) ? client.sendMedia(chatId, text, 'file', '', m, { ...options }) : client.sendText(chatId, text, m, { ...options });
    m.copy = () => smsg(client, M.fromObject(M.toObject(m)));
    m.copyNForward = (jid = m.chat, forceForward = false, options = {}) => client.copyNForward(jid, m, forceForward, options);

    return m;
}

async function handleMessage(client, m) {
    try {
        const body = (
            (m.mtype === 'conversation' && m.message.conversation) ||
            (m.mtype === 'imageMessage' && m.message.imageMessage.caption) ||
            (m.mtype === 'documentMessage' && m.message.documentMessage.caption) ||
            (m.mtype === 'videoMessage' && m.message.videoMessage.caption) ||
            (m.mtype === 'extendedTextMessage' && m.message.extendedTextMessage.text) ||
            (m.mtype === 'buttonsResponseMessage' && m.message.buttonsResponseMessage.selectedButtonId) ||
            (m.mtype === 'templateButtonReplyMessage' && m.message.templateButtonReplyMessage.selectedId)
        ) ? (
            (m.mtype === 'conversation' && m.message.conversation) ||
            (m.mtype === 'imageMessage' && m.message.imageMessage.caption) ||
            (m.mtype === 'documentMessage' && m.message.documentMessage.caption) ||
            (m.mtype === 'videoMessage' && m.message.videoMessage.caption) ||
            (m.mtype === 'extendedTextMessage' && m.message.extendedTextMessage.text) ||
            (m.mtype === 'buttonsResponseMessage' && m.message.buttonsResponseMessage.selectedButtonId) ||
            (m.mtype === 'templateButtonReplyMessage' && m.message.templateButtonReplyMessage.selectedId)
        ) : '';
        const sender = m.key.fromMe ? client.user.id.split(":")[0] + "@s.whatsapp.net" ||
              client.user.id : m.key.participant || m.key.remoteJid;

        const prefixRegex = /^[°zZ#$@*+,.?=''():√%!¢£¥€π¤ΠΦ_&><`™©®Δ^βα~¦|/\\©^]/;
        const prefix = prefixRegex.test(body) ? body.match(prefixRegex)[0] : '.';
        const isCmd = body.startsWith(prefix);
        const args = body.trim().split(/ +/).slice(1);
        const text = args.join(" ");
        const senderNumber = sender.split('@')[0];
        const botNumber = await client.decodeJid(client.user.id);
        const isBot = botNumber.includes(senderNumber)
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';

        switch (command) {
            case "x": {
                if (!isBot) return
                m.reply("online");
            }
            break;
            case 'vn':
            case 'ptt': {
                if (!isBot) return
                let url = text?.trim();
                if (url && url.startsWith('http')) {
                    await client.sendAudio(m.chat, url, {
                        ptt: true,
                        quoted: m
                    });
                    return;
                }
                if (!m.quoted || (m.quoted.mtype !== 'audioMessage' && m.quoted.mtype !== 'videoMessage')) return m.reply('reply ke audio/video atau sertakan URL.');
                let buff = await m.quoted.download();
                await client.sendAudio(m.chat, buff, {
                    ptt: true,
                    quoted: m
                });
            }
            break;
        }
    } catch (err) {
        console.log(err);
    }
}

async function startBase() {
    const {
        state,
        saveCreds
    } = await useMultiFileAuthState("sessions");
    
    const client = makeWASocket({
        printQRInTerminal: false,
        browser: ["Windows", "Edge", ""],
        logger: pino({ level: "fatal" }),
        auth: state
    });
    
    if(!client.authState.creds.registered) {
        console.log("masukkan nomor:\nex: 628xxx");
        const phoneNumber = await question("phone: ");
        const code = await client.requestPairingCode(phoneNumber);
        console.log(`pairing code: ${code}`);
    }
    
    client.ev.on("creds.update", saveCreds);
    store.bind(client.ev);
    client.public = true;

    client.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
          let decode = jidDecode(jid) || {};
          return decode.user && decode.server && decode.user + '@' + decode.server || jid;
        } else return jid;
    };
    
    client.downloadMediaMessage = async (message) => {
        let mime = (message.msg || message).mimetype || '';
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
        const stream = await downloadContentFromMessage(message, messageType);
        let buffer = Buffer.from([]);
        for await(const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    };
    
    client.sendAudio = async (jid, buff, options = {}) => {
        async function downloadAudio(input) {
            if (Buffer.isBuffer(input)) return input;
            if (typeof input === 'string' && (input.startsWith('http') || input.startsWith('https'))) {
                const response = await axios.get(input, { 
                    responseType: 'arraybuffer',
                    timeout: 30000
                });
                return Buffer.from(response.data);
            } else if (typeof input === 'string') {
                return fs.readFileSync(input);
            } else {
                throw new Error('Input harus Buffer, URL, atau path file');
            }
        }
        
        const audioBuffer = await downloadAudio(buff);
        const opusBuffer = await new Promise((resolve, reject) => {
            const inStream = new PassThrough();
            const outStream = new PassThrough();
            const chunks = [];
            inStream.end(audioBuffer);
            ff(inStream)
                .noVideo()
                .audioCodec('libopus')
                .format('ogg')
                .audioBitrate('48k')
                .audioChannels(1)
                .audioFrequency(48000)
                .outputOptions([
                    '-vn',
                    '-b:a 64k',
                    '-ac 2',
                    '-ar 48000',
                    '-map_metadata', '-1',
                    '-application', 'voip'
                ])
                .on('error', reject)
                .on('end', () => resolve(Buffer.concat(chunks)))
                .pipe(outStream, { end: true });
            outStream.on('data', c => chunks.push(c));
        });
        
        const waveform = await new Promise((resolve, reject) => {
            const inputStream = new PassThrough();
            inputStream.end(audioBuffer);
            const chunks = [];
            const bars = 64;
            ff(inputStream)
                .audioChannels(1)
                .audioFrequency(16000)
                .format('s16le')
                .on('error', reject)
                .on('end', () => {
                    const rawData = Buffer.concat(chunks);
                    const samples = rawData.length / 2;
                    const amplitudes = [];
                    
                    for (let i = 0; i < samples; i++) {
                        amplitudes.push(Math.abs(rawData.readInt16LE(i * 2)) / 32768);
                    }
                    
                    const blockSize = Math.floor(amplitudes.length / bars);
                    const avg = [];
                    for (let i = 0; i < bars; i++) {
                        const block = amplitudes.slice(i * blockSize, (i + 1) * blockSize);
                        avg.push(block.reduce((a, b) => a + b, 0) / block.length);
                    }
                
                    const max = Math.max(...avg);
                    const normalized = avg.map(v => Math.floor((v / max) * 100));
                    resolve(Buffer.from(new Uint8Array(normalized)).toString('base64'));
                })
                .pipe()
                .on('data', chunk => chunks.push(chunk));
        });
        
        return await client.sendMessage(jid, {
            audio: opusBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: options.ptt !== undefined ? options.ptt : true,
            waveform: waveform
        }, {
            quoted: options.quoted,
            ephemeralExpiration: options.ephemeralExpiration,
            contextInfo: options.contextInfo
        });
    };
      
    client.sendText = (jid, text, quoted = '', options) => client.sendMessage(jid, { text: text, ...options }, { quoted });

    client.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            if (reason === DisconnectReason.badSession) {
                console.log(`bad session file, please delete session and scan again`);
                process.exit();
            } else if (reason === DisconnectReason.connectionClosed) {
                console.log("connection closed, reconnecting....");
                startBase();
            } else if (reason === DisconnectReason.connectionLost) {
                console.log("connection lost from server, reconnecting...");
                startBase();
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log("connection replaced, another new session opened, please restart bot");
                process.exit();
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(`device loggedout, please delete folder session and scan again.`);
                process.exit();
            } else if (reason === DisconnectReason.restartRequired) {
                console.log("restart required, restarting...");
                startBase();
            } else if (reason === DisconnectReason.timedOut) {
                console.log("connection timedout, reconnecting...");
                startBase();
            } else {
                console.log(`unknown disconnectReason: ${reason}|${connection}`);
                startBase();
            }
        } else if (connection === "open") {
            console.log('berhasil tersambung');
        }
    });
  
    client.ev.on('messages.upsert', async chatUpdate => {
        try {
            let msg = chatUpdate.messages[0];
            if (!msg.message) return;
            msg.message = (Object.keys(msg.message)[0] === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
            if (msg.key && msg.key.remoteJid === 'status@broadcast') return;
            if (!client.public && !msg.key.fromMe && chatUpdate.type === 'notify') return;
            if (msg.key.id.startsWith('BAE5') && msg.key.id.length === 16) return;
            let m = smsg(client, msg, store);
            await handleMessage(client, m, chatUpdate, store);
        } catch (err) {
            console.log(err);
        }
    });
}

startBase();
