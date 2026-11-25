// JPM HRMS WhatsApp bot.
// Runs on an always-on office PC. Once a day, at the send time HR sets in the app, it posts the newest
// imported attendance report's present / absent / late / early-departure / missing-punch summary to a
// WhatsApp group, department by department in the order HR sets, tagging each
// department's HOD and the employee. First run: scan the QR code with the WhatsApp account that is a
// member of the group (WhatsApp > Linked devices > Link a device).
//
//   npm install          (once)
//   npm start            (keep running)
//   npm run preview      (print the next message without sending it)

// The WhatsApp encryption library (libsignal) prints harmless session noise straight to the console
// ("Closing session", "Bad MAC", ...) after a restart. Hide it so the bot window stays readable.
const SIGNAL_NOISE = /^(Closing (open |stale open )?session|Opening session|Failed to decrypt message|Session error|Removing old closed session|Migrating session|Decrypted message with closed session|Session already (closed|open))/;
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && SIGNAL_NOISE.test(args[0])) return;
    original(...args);
  };
}

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

const DIVIDER = '━━━━━━━━━━━━━━━━';
const minutesText = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min} min`);

/** Build the group message text and the list of JIDs to tag. Names come first so they line up; tags go at the end. */
function buildMessage(report) {
  const mentions = new Set();
  const tag = (person) => {
    if (!person.phone) return '';
    mentions.add(jidOf(person.phone));
    return ` @${person.phone}`;
  };
  const day = new Date(`${report.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' });
  // Departments arrive in the order HR chose in Settings.
  const departments = report.departments.map((d) => ({
    ...d, present: d.present || 0, absent: d.absent || [], early: d.early || [],
  }));
  const total = (pick) => departments.reduce((n, d) => n + pick(d), 0);
  const listFor = (title, people, detail = () => '') => {
    if (!people.length) return;
    lines.push('', `${title} (${people.length})*`);
    people.forEach((p, i) => lines.push(`${i + 1}. ${p.name} (${p.ticket})${detail(p)}${tag(p)}`));
  };

  const lines = ['📋 *JPM ATTENDANCE REPORT*', `📅 ${report.dateLabel} (${day})`, ''];
  lines.push(
    `✅ Present: *${total((d) => d.present)}*`,
    `❌ Absent: *${total((d) => d.absent.length)}*`,
    `⏰ Late arrivals: *${total((d) => d.late.length)}*`,
    `🏃 Early departures: *${total((d) => d.early.length)}*`,
    `⚠️ Missing punches: *${total((d) => d.missing.length)}*`,
  );

  for (const dept of departments) {
    lines.push('', DIVIDER, `🏢 *${dept.department.toUpperCase()}*`);
    if (dept.hod.name || dept.hod.phone) lines.push(`👤 HOD: ${dept.hod.name || ''}${tag(dept.hod)}`.replace(/HOD: {2}@/, 'HOD: @'));
    lines.push(`✅ Present: ${dept.present} · ❌ Absent: ${dept.absent.length}`);
    listFor('❌ *Absent', dept.absent);
    listFor('⏰ *Late arrivals', dept.late, (p) => ` – ${minutesText(p.lateMinutes)}`);
    listFor('🏃 *Early departures', dept.early, (p) => ` – ${minutesText(p.earlyMinutes)} early`);
    listFor('⚠️ *Missing punches', dept.missing);
    if (!dept.absent.length && !dept.late.length && !dept.early.length && !dept.missing.length) {
      lines.push('👍 All present, on time, punches complete.');
    }
  }
  lines.push('', DIVIDER, '_Auto message · JPM HRMS_');
  return { text: lines.join('\n'), mentions: [...mentions] };
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
    lastError = null; // clear an old "group not found" as soon as the group is found
    if (!settings.enabled || !report || !group) return;
    if (!report.resend && localTime() < settings.sendTime) return; // "Send again" goes out straight away
    const key = report.sendKey || report.date;
    const sent = readSent();
    if (!sent.includes(key)) {
      const { text, mentions } = buildMessage(report);
      await sock.sendMessage(group.id, { text, mentions });
      writeSent([...sent, key]);
      log(`${report.resend ? 'Re-sent' : 'Sent'} ${report.dateLabel} report to "${group.subject}" (${mentions.length} tagged).`);
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
