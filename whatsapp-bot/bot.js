// JPM HRMS WhatsApp bot.
// Runs on an always-on office PC. Once a day, at the send time HR sets in the app, it posts the newest
// imported attendance report's late arrivals and missing punches to a WhatsApp group, tagging each
// department's HOD and the employee. First run: scan the QR code with the WhatsApp account that is a
// member of the group (WhatsApp > Linked devices > Link a device).
//
//   npm install          (once)
//   npm start            (keep running)
//   npm run preview      (print the next message without sending it)

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const CONFIG_FILE = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('config.json not found. Copy config.example.json to config.json and fill in apiUrl and botToken.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const API = String(config.apiUrl || '').replace(/\/+$/, '');
const TOKEN = String(config.botToken || '');
if (!API || !TOKEN) {
  console.error('config.json needs both apiUrl and botToken.');
  process.exit(1);
}

const PREVIEW = process.argv.includes('--preview');
const CHECK_EVERY_MS = 60 * 1000;
const log = (...args) => console.log(new Date().toLocaleString('en-IN'), '-', ...args);

let sock = null;
let state = 'starting';
let groupFound = null;
let lastError = null;
let sending = false;

async function api(pathname, options = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Bot-Token': TOKEN, ...(options.headers || {}) },
    signal: AbortSignal.timeout(90 * 1000), // Render free instances can take ~60 s to wake up
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `API ${pathname} failed (${response.status})`);
  return body;
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localTime = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const jidOf = (phone) => `${phone}@s.whatsapp.net`;

// Dates already posted from this PC, so a failed "sent" call to the server never causes a double post.
const SENT_FILE = path.join(__dirname, 'sent.json');
const readSent = () => { try { return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch { return []; } };
const writeSent = (dates) => fs.writeFileSync(SENT_FILE, JSON.stringify(dates.slice(-60)));

/** Build the group message text and the list of JIDs to tag. */
function buildMessage(report) {
  const mentions = new Set();
  const tag = (person) => {
    if (person.phone) {
      mentions.add(jidOf(person.phone));
      return `@${person.phone}`;
    }
    return '';
  };
  const lines = [`*JPM Attendance · ${report.dateLabel}*`, 'Late arrivals and missing punches', ''];
  const departments = report.departments.filter((d) => d.late.length || d.missing.length);
  if (!departments.length) {
    lines.push('✅ Everyone was on time and every punch is complete.');
    return { text: lines.join('\n'), mentions: [] };
  }
  for (const dept of departments) {
    const hodTag = dept.hod.phone ? tag(dept.hod) : '';
    const hodText = hodTag ? `HOD ${hodTag}` : dept.hod.name ? `HOD ${dept.hod.name}` : 'HOD not set';
    lines.push(`*${dept.department}* · ${hodText}`);
    if (dept.late.length) {
      lines.push(`⏰ Late (${dept.late.length})`);
      for (const p of dept.late) lines.push(`• ${[tag(p), p.name].filter(Boolean).join(' ')} (${p.ticket}) · ${p.lateMinutes} min late`);
    }
    if (dept.missing.length) {
      lines.push(`⚠️ Missing punch (${dept.missing.length})`);
      for (const p of dept.missing) lines.push(`• ${[tag(p), p.name].filter(Boolean).join(' ')} (${p.ticket})`);
    }
    lines.push('');
  }
  lines.push('_Sent automatically by JPM HRMS_');
  return { text: lines.join('\n').trim(), mentions: [...mentions] };
}

async function findGroup(name) {
  const groups = await sock.groupFetchAllParticipating();
  const wanted = name.trim().toLowerCase();
  return Object.values(groups).find((g) => (g.subject || '').trim().toLowerCase() === wanted) || null;
}

async function heartbeat() {
  try {
    await api('/api/whatsapp/heartbeat', { method: 'POST', body: JSON.stringify({ state, groupFound, lastError }) });
  } catch (error) {
    log('Heartbeat failed:', error.message);
  }
}

async function tick() {
  if (sending) return;
  sending = true;
  try {
    const { settings, report } = await api(`/api/whatsapp/pending?today=${localDate()}`);
    if (PREVIEW) {
      console.log(report ? buildMessage(report).text : 'No unsent report in the last few days.');
      process.exit(0);
    }
    if (state !== 'connected') return;
    const group = settings.groupName ? await findGroup(settings.groupName) : null;
    groupFound = settings.groupName ? Boolean(group) : null;
    if (settings.groupName && !group) {
      lastError = `Group "${settings.groupName}" not found. Is this WhatsApp number a member?`;
      return;
    }
    if (!settings.enabled || !report || !group || localTime() < settings.sendTime) return;
    const sent = readSent();
    if (!sent.includes(report.date)) {
      const { text, mentions } = buildMessage(report);
      await sock.sendMessage(group.id, { text, mentions });
      writeSent([...sent, report.date]);
      log(`Sent ${report.dateLabel} report to "${group.subject}" (${mentions.length} tagged).`);
    }
    // Tell the server (retried on the next tick if the server is asleep; the local file prevents a resend)
    await api('/api/whatsapp/sent', { method: 'POST', body: JSON.stringify({ date: report.date }) });
    lastError = null;
  } catch (error) {
    lastError = error.message;
    log('Error:', error.message);
  } finally {
    sending = false;
    if (!PREVIEW) await heartbeat();
  }
}

async function connect() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth'));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth, logger: pino({ level: 'silent' }), browser: ['JPM HRMS', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      state = 'waiting-for-qr';
      log('Scan this QR code: WhatsApp > Linked devices > Link a device');
      qrcode.generate(qr, { small: true });
      void heartbeat();
    }
    if (connection === 'open') {
      state = 'connected';
      log('WhatsApp connected.');
      void tick();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        state = 'logged-out';
        lastError = 'WhatsApp logged this bot out. Delete the whatsapp-bot/auth folder and restart to scan again.';
        log(lastError);
        void heartbeat();
        return;
      }
      state = 'reconnecting';
      log('Connection closed, reconnecting in 5 s...');
      setTimeout(() => { void connect(); }, 5000);
    }
  });
}

if (PREVIEW) {
  void tick();
} else {
  log(`JPM WhatsApp bot starting. API: ${API}`);
  void connect();
  setInterval(() => { void tick(); }, CHECK_EVERY_MS);
}
