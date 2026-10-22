// Vercel serverless function: the in-platform mailbox (rounds 10 and 11).
// Who may message whom is decided here, on the server:
//   - an admin can message anyone
//   - a coach can message their own clients who have joined
//   - a client can message their own coach
//   - coach to coach and client to client are not allowed
//   - a block in either direction stops messages (admins are not blocked)
// Every request is a POST with { action, ...details } and a Firebase ID token.

const { admin, getDb, sendWithResend } = require('./_lib');

const MAX_TEXT = 2000;
const MAX_MESSAGES = 200;
const MAX_IMAGE_CHARS = 400000; // about 300 KB as a JPEG, stored inside the message record
const NOTIFY_EVERY_MS = 30 * 60 * 1000;
const LANGUAGES = { et: 'Estonian', ru: 'Russian', en: 'English' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cleanText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const iso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : (v || null));
const nowMs = () => Date.now();

function adminEmailList() {
  return String(process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

async function isAdminEmail(db, email) {
  if (!email) return false;
  if (adminEmailList().includes(email)) return true;
  return (await db.collection('admins').doc(email).get()).exists;
}

async function identify(req, db) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (err) {
    return null;
  }
  const email = String(decoded.email || '').toLowerCase();
  if (decoded.email_verified !== true || !email) return null;
  const userSnap = await db.collection('users').doc(decoded.uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  const isAdmin = await isAdminEmail(db, email);
  if (!isAdmin && (!user || user.status === 'closed' || user.status === 'suspended')) return null;
  return { uid: decoded.uid, email, name: (user && (user.displayName || user.email)) || email, role: user ? user.role : '', isAdmin };
}

async function profileOf(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const d = snap.data();
  const email = String(d.email || '').toLowerCase();
  return { uid, name: d.displayName || d.email || '', email, role: d.role || '', status: d.status || 'active', isAdmin: await isAdminEmail(db, email) };
}

async function linkedClient(db, coachUid, clientUid) {
  const snap = await db.collection('clients').where('coachId', '==', coachUid).where('userId', '==', clientUid).limit(1).get();
  return !snap.empty;
}

async function isBlocked(db, a, b) {
  const [x, y] = await Promise.all([db.collection('blocks').doc(`${a}__${b}`).get(), db.collection('blocks').doc(`${b}__${a}`).get()]);
  return x.exists || y.exists;
}

async function canMessage(db, me, other) {
  if (!other || other.uid === me.uid) return false;
  if (me.isAdmin || other.isAdmin) return true;
  if (await isBlocked(db, me.uid, other.uid)) return false;
  if (me.role === 'coach' && other.role === 'client') return linkedClient(db, me.uid, other.uid);
  if (me.role === 'client' && other.role === 'coach') return linkedClient(db, other.uid, me.uid);
  return false;
}

const conversationIdFor = (a, b) => [a, b].sort().join('__');
const flagsFor = (conv, uid) => ((conv.flags && conv.flags[uid]) || {});

// ---- contacts, inbox and unread ----

// The BodUp admin, shown to everyone as the default "Contact admin" entry
async function supportContact(db) {
  for (const email of adminEmailList()) {
    const snap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!snap.empty) return { uid: snap.docs[0].id, name: 'BodUp admin', role: 'admin' };
  }
  return null;
}

async function contacts(db, me) {
  const out = [];
  const support = me.isAdmin ? null : await supportContact(db);
  if (support) out.push(support);
  if (me.isAdmin) {
    const users = await db.collection('users').limit(500).get();
    users.docs.forEach((d) => {
      const u = d.data();
      if (d.id !== me.uid && (u.role === 'coach' || u.role === 'client') && u.status !== 'closed') out.push({ uid: d.id, name: u.displayName || u.email || '', role: u.role });
    });
  } else if (me.role === 'coach') {
    const mine = await db.collection('clients').where('coachId', '==', me.uid).limit(500).get();
    mine.docs.forEach((d) => { if (d.data().userId) out.push({ uid: d.data().userId, name: d.data().name || '', role: 'client' }); });
  } else if (me.role === 'client') {
    const mine = await db.collection('clients').where('userId', '==', me.uid).limit(5).get();
    for (const d of mine.docs) {
      const coach = await profileOf(db, d.data().coachId);
      if (coach) out.push({ uid: coach.uid, name: coach.name, role: 'coach' });
    }
  }
  return { contacts: [...(support ? [support] : []), ...out.filter((c) => !support || c.uid !== support.uid).sort((a, b) => a.name.localeCompare(b.name))] };
}

async function myConversations(db, me) {
  const snap = await db.collection('conversations').where('participants', 'array-contains', me.uid).limit(300).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function inbox(db, me, body) {
  const showArchived = body.archived === true;
  const rows = (await myConversations(db, me)).map((c) => {
    const other = c.participants.find((p) => p !== me.uid);
    const f = flagsFor(c, me.uid);
    return {
      id: c.id,
      withUid: other,
      withName: (c.names && c.names[other]) || 'Unknown',
      lastText: c.lastText || '',
      lastFrom: c.lastFrom || '',
      lastAt: iso(c.lastAt),
      unread: (c.unread && c.unread[me.uid]) || 0,
      pinned: !!f.pinned,
      muted: !!f.muted,
      archived: !!f.archived
    };
  }).filter((r) => (showArchived ? r.archived : !r.archived));
  rows.sort((a, b) => (b.pinned - a.pinned) || String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  const unreadTotal = rows.reduce((t, r) => t + (r.muted ? 0 : r.unread), 0);
  const support = me.isAdmin ? null : await supportContact(db);
  return { conversations: rows, unreadTotal, support };
}

async function unread(db, me) {
  const r = await inbox(db, me, {});
  return { unreadTotal: r.unreadTotal };
}

// ---- thread, sending, reading ----

async function thread(db, me, body) {
  const other = await profileOf(db, String(body.with || '_'));
  if (!(await canMessage(db, me, other))) throw new HttpError(403, 'You cannot message this person.');
  const id = conversationIdFor(me.uid, other.uid);
  const snap = await db.collection('messages').where('conversationId', '==', id).limit(MAX_MESSAGES).get();
  const messages = snap.docs
    .map((d) => ({ id: d.id, from: d.data().from, text: d.data().text, image: d.data().image || null, at: iso(d.data().at), reported: !!d.data().reported }))
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const conv = (await db.collection('conversations').doc(id).get()).data() || {};
  const f = flagsFor(conv, me.uid);
  const blocked = await isBlocked(db, me.uid, other.uid);
  return { messages, withName: other.name, withUid: other.uid, flags: { pinned: !!f.pinned, muted: !!f.muted, archived: !!f.archived }, blocked };
}

async function notifyByEmail(db, sender, recipient, conv) {
  try {
    const muted = flagsFor(conv, recipient.uid).muted;
    const last = conv.notified && conv.notified[recipient.uid] ? conv.notified[recipient.uid] : 0;
    if (muted || nowMs() - last < NOTIFY_EVERY_MS || !recipient.email) return;
    if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) return;
    await sendWithResend({
      to: recipient.email,
      subject: 'You have a new message on BodUp',
      text: `${sender.name} sent you a message on BodUp.\n\nSign in to read it: https://www.bodup.ee\n\nFor your privacy, the message itself is not included in this email.`,
      fromName: 'BodUp'
    });
    return { notified: { [recipient.uid]: nowMs() } };
  } catch (err) {
    console.error('message alert email failed:', err);
  }
  return null;
}

async function send(db, me, body) {
  const text = cleanText(body.text, MAX_TEXT);
  const image = typeof body.image === 'string' && body.image ? body.image : null;
  if (!text && !image) throw new HttpError(400, 'Write a message or add a picture first.');
  if (image && (!image.startsWith('data:image/') || image.length > MAX_IMAGE_CHARS)) throw new HttpError(400, 'Pictures must be JPG or PNG, under about 300 KB.');
  const other = await profileOf(db, String(body.to || '_'));
  if (!(await canMessage(db, me, other))) throw new HttpError(403, 'You cannot message this person.');
  const id = conversationIdFor(me.uid, other.uid);
  const now = admin.firestore.Timestamp.now();
  await db.collection('messages').add({ conversationId: id, from: me.uid, text, image, at: now, reported: false });
  const ref = db.collection('conversations').doc(id);
  const existing = await ref.get();
  const conv = existing.exists ? existing.data() : {};
  const alert = await notifyByEmail(db, me, other, conv);
  await ref.set({
    participants: [me.uid, other.uid].sort(),
    names: { [me.uid]: me.name, [other.uid]: other.name },
    lastText: (text || 'Picture').slice(0, 140),
    lastFrom: me.uid,
    lastAt: now,
    unread: { [other.uid]: admin.firestore.FieldValue.increment(1), [me.uid]: 0 },
    ...(alert || {})
  }, { merge: true });
  return { ok: true };
}

async function markRead(db, me, body) {
  const id = conversationIdFor(me.uid, String(body.with || '_'));
  const ref = db.collection('conversations').doc(id);
  if ((await ref.get()).exists) await ref.update({ [`unread.${me.uid}`]: 0 });
  return { ok: true };
}

// ---- pin, mute, archive, block, report ----

async function setFlag(db, me, body) {
  const other = String(body.with || '_');
  const id = conversationIdFor(me.uid, other);
  const ref = db.collection('conversations').doc(id);
  if (!(await ref.get()).exists) throw new HttpError(404, 'Conversation not found.');
  const f = {};
  ['pinned', 'muted', 'archived'].forEach((k) => { if (typeof body[k] === 'boolean') f[`flags.${me.uid}.${k}`] = body[k]; });
  if (Object.keys(f).length === 0) throw new HttpError(400, 'Nothing to change.');
  await ref.update(f);
  return { ok: true };
}

async function block(db, me, body) {
  const other = String(body.with || '_');
  if (other === me.uid) throw new HttpError(400, 'You cannot block yourself.');
  const ref = db.collection('blocks').doc(`${me.uid}__${other}`);
  if (body.blocked === true) await ref.set({ blocker: me.uid, blocked: other, at: admin.firestore.Timestamp.now() });
  else await ref.delete();
  return { ok: true };
}

async function report(db, me, body) {
  const snap = await db.collection('messages').doc(String(body.messageId || '_')).get();
  if (!snap.exists) throw new HttpError(404, 'Message not found.');
  const m = snap.data();
  if (!m.conversationId || !m.conversationId.split('__').includes(me.uid)) throw new HttpError(403, 'You cannot report this message.');
  const reason = cleanText(body.reason, 300) || 'No reason given';
  await db.collection('reports').add({ messageId: snap.id, conversationId: m.conversationId, reporter: me.uid, reporterName: me.name, reason, status: 'open', at: admin.firestore.Timestamp.now() });
  await db.collection('messages').doc(snap.id).update({ reported: true });
  return { ok: true };
}

async function adminReports(db, me) {
  if (!me.isAdmin) throw new HttpError(403, 'Not allowed.');
  const snap = await db.collection('reports').limit(200).get();
  const rows = await Promise.all(snap.docs.map(async (d) => {
    const r = d.data();
    const msg = (await db.collection('messages').doc(r.messageId).get()).data() || {};
    return { id: d.id, reason: r.reason, reporterName: r.reporterName || '', status: r.status || 'open', at: iso(r.at), text: msg.text || '', conversationId: r.conversationId };
  }));
  return { reports: rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))) };
}

async function reportResolve(db, me, body) {
  if (!me.isAdmin) throw new HttpError(403, 'Not allowed.');
  await db.collection('reports').doc(String(body.id || '_')).update({ status: body.status === 'open' ? 'open' : 'closed' });
  return { ok: true };
}

// ---- search across my conversations ----

async function search(db, me, body) {
  const q = cleanText(body.q, 80).toLowerCase();
  if (q.length < 2) return { results: [] };
  const results = [];
  for (const c of await myConversations(db, me)) {
    const snap = await db.collection('messages').where('conversationId', '==', c.id).limit(MAX_MESSAGES).get();
    const other = c.participants.find((p) => p !== me.uid);
    snap.docs.forEach((d) => {
      const m = d.data();
      if ((m.text || '').toLowerCase().includes(q)) results.push({ id: d.id, withUid: other, withName: (c.names && c.names[other]) || '', text: m.text, at: iso(m.at) });
    });
  }
  return { results: results.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 40) };
}

// ---- quick reply templates (each coach or client keeps their own) ----

async function templatesList(db, me) {
  const snap = await db.collection('templates').where('ownerUid', '==', me.uid).limit(100).get();
  return { templates: snap.docs.map((d) => ({ id: d.id, title: d.data().title, text: d.data().text })) };
}

async function templateSave(db, me, body) {
  const title = cleanText(body.title, 60);
  const text = cleanText(body.text, 1000);
  if (!title || !text) throw new HttpError(400, 'Give the template a name and some text.');
  const ref = body.id ? db.collection('templates').doc(String(body.id)) : db.collection('templates').doc();
  if (body.id) {
    const snap = await ref.get();
    if (!snap.exists || snap.data().ownerUid !== me.uid) throw new HttpError(403, 'Not allowed.');
  }
  await ref.set({ ownerUid: me.uid, title, text, at: admin.firestore.Timestamp.now() }, { merge: true });
  return { ok: true, id: ref.id };
}

async function templateDelete(db, me, body) {
  const ref = db.collection('templates').doc(String(body.id || '_'));
  const snap = await ref.get();
  if (!snap.exists || snap.data().ownerUid !== me.uid) throw new HttpError(403, 'Not allowed.');
  await ref.delete();
  return { ok: true };
}

// ---- Claude: translation and reply drafts (needs ANTHROPIC_API_KEY) ----

async function claude(system, userText, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, 'AI features are not switched on yet (ANTHROPIC_API_KEY is missing).');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: userText }] })
  });
  if (!res.ok) throw new HttpError(502, 'The AI service did not respond. Try again.');
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function translate(db, me, body) {
  const to = LANGUAGES[body.to] ? body.to : 'en';
  const text = cleanText(body.text, MAX_TEXT);
  if (!text) throw new HttpError(400, 'Nothing to translate.');
  const out = await claude(
    `Translate the user's message into ${LANGUAGES[to]}. Return only the translation. Keep names, numbers and emojis as they are.`,
    text, 800
  );
  return { text: out, to };
}

async function draftReply(db, me, body) {
  if (!me.isAdmin && me.role !== 'coach') throw new HttpError(403, 'Only coaches can ask for a reply draft.');
  const other = await profileOf(db, String(body.with || '_'));
  if (!(await canMessage(db, me, other))) throw new HttpError(403, 'You cannot message this person.');
  const id = conversationIdFor(me.uid, other.uid);
  const snap = await db.collection('messages').where('conversationId', '==', id).limit(MAX_MESSAGES).get();
  const recent = snap.docs.map((d) => d.data()).sort((a, b) => String(iso(a.at)).localeCompare(String(iso(b.at)))).slice(-10);
  if (recent.length === 0) throw new HttpError(400, 'There is no message to reply to yet.');
  const transcript = recent.map((m) => `${m.from === me.uid ? 'Coach' : 'Client'}: ${m.text || '[picture]'}`).join('\n');
  const out = await claude(
    'You help a fitness coach reply to a client. Write one short, warm, practical reply in the same language as the client. Do not give medical advice, diagnoses or calorie targets. Return only the reply text, for the coach to review and edit.',
    `Conversation so far:\n${transcript}\n\nWrite the coach's next reply.`,
    400
  );
  return { text: out };
}

const ACTIONS = {
  contacts, inbox, unread, thread, send, markRead, setFlag, block, report, search,
  templatesList, templateSave, templateDelete, translate, draftReply,
  adminReports, reportResolve
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  try {
    const db = getDb();
    const me = await identify(req, db);
    if (!me) return res.status(401).json({ error: 'Please sign in again.' });
    const body = req.body || {};
    const action = String(body.action || '');
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return res.status(400).json({ error: 'Unknown action.' });
    const result = await ACTIONS[action](db, me, body);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('messages endpoint failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
