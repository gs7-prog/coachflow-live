// Vercel serverless function: everything the admin page needs, in one endpoint.
//
// WHO IS AN ADMIN
//   Only people whose verified Google email is listed in the ADMIN_EMAILS environment variable
//   (comma separated). Nothing in the database is trusted for this, because a user can edit
//   their own database record. If ADMIN_EMAILS is empty, nobody is an admin.
//
// Every request is a POST with { action, ...details } and a Firebase ID token in the
// Authorization header. The data is read with the Admin SDK on the server, so the admin page
// does not need (and does not widen) any database access for the browser.

const { admin, getDb } = require('./_lib');

const MAX_DOCS = 1000;
const MAX_EMAILS = 300;
const MAX_MESSAGES = 200;
const MAX_INVOICES = 100;

const iso = (v) => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : null);
const time = (v) => (v && typeof v.toDate === 'function' ? v.toDate().getTime() : 0);

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function identify(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  getDb();
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = String(decoded.email || '').toLowerCase();
    return {
      uid: decoded.uid,
      email,
      isAdmin: decoded.email_verified === true && !!email && adminEmails().includes(email)
    };
  } catch (err) {
    return null;
  }
}

function todayKey(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const readAll = async (db, name) => {
  const snap = await db.collection(name).limit(MAX_DOCS).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

const audit = (db, who, action, target, details) =>
  db.collection('adminAudit').add({
    actor: who.email,
    action,
    target,
    details: details || null,
    at: admin.firestore.FieldValue.serverTimestamp()
  });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function overview(db) {
  const [users, clients, messages, emails] = await Promise.all([
    readAll(db, 'users'),
    readAll(db, 'clients'),
    readAll(db, 'adminMessages'),
    readAll(db, 'scheduledEmails')
  ]);
  const since = Date.now() - 30 * 86400000;
  const status = (u) => u.status || 'active';
  return {
    coaches: users.filter((u) => u.role === 'coach').length,
    suspendedCoaches: users.filter((u) => u.role === 'coach' && status(u) === 'suspended').length,
    clientAccounts: users.filter((u) => u.role === 'client').length,
    closedAccounts: users.filter((u) => status(u) === 'closed').length,
    joinedClients: clients.filter((c) => c.userId).length,
    pendingInvites: clients.filter((c) => !c.userId).length,
    newMessages: messages.filter((m) => (m.status || 'new') === 'new').length,
    failedEmails: emails.filter((e) => e.status === 'failed').length,
    scheduledEmails: emails.filter((e) => e.status === 'scheduled').length,
    signUpsLast30Days: users.filter((u) => time(u.createdAt) >= since).length
  };
}

async function messages(db) {
  const list = await readAll(db, 'adminMessages');
  return {
    messages: list
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
      .slice(0, MAX_MESSAGES)
      .map((m) => ({
        id: m.id,
        senderId: m.coachId || null,
        role: m.role || 'coach',
        name: m.name || '',
        email: m.email || '',
        subject: m.subject || '',
        message: m.message || '',
        status: m.status || 'new',
        createdAt: iso(m.createdAt),
        handledAt: iso(m.handledAt)
      }))
  };
}

async function setMessageStatus(db, body, who) {
  const id = String(body.id || '');
  const status = String(body.status || '');
  if (!id || !['new', 'handled'].includes(status)) throw new HttpError(400, 'Invalid request.');
  const ref = db.collection('adminMessages').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Message not found.');
  await ref.update({
    status,
    handledAt: status === 'handled' ? admin.firestore.FieldValue.serverTimestamp() : null
  });
  await audit(db, who, 'message-status', id, status);
  return { ok: true };
}

async function users(db) {
  const [userList, clients, subs] = await Promise.all([
    readAll(db, 'users'),
    readAll(db, 'clients'),
    readAll(db, 'subscriptions')
  ]);
  const names = Object.fromEntries(userList.map((u) => [u.id, u.displayName || u.email || u.id]));
  const clientCount = {};
  const coachOfUser = {};
  clients.forEach((c) => {
    clientCount[c.coachId] = (clientCount[c.coachId] || 0) + 1;
    if (c.userId) coachOfUser[c.userId] = c.coachId;
  });
  const planOf = Object.fromEntries(subs.map((s) => [s.id, s]));

  return {
    users: userList
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
      .map((u) => ({
        uid: u.id,
        email: u.email || '',
        displayName: u.displayName || '',
        role: u.role || '',
        status: u.status || 'active',
        createdAt: iso(u.createdAt),
        clientCount: u.role === 'coach' ? clientCount[u.id] || 0 : null,
        coachName: u.role === 'client' && coachOfUser[u.id] ? names[coachOfUser[u.id]] || '' : '',
        plan: u.role === 'coach' && planOf[u.id] ? `${planOf[u.id].planName} (${planOf[u.id].status})` : ''
      }))
  };
}

async function setUserStatus(db, body, who) {
  const uid = String(body.uid || '');
  const status = String(body.status || '');
  if (!uid || !['active', 'suspended', 'closed'].includes(status)) throw new HttpError(400, 'Invalid request.');

  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'User not found.');
  const user = snap.data();

  if (user.role !== 'coach' && user.role !== 'client') throw new HttpError(400, 'Only coach and client accounts can be changed.');
  if (adminEmails().includes(String(user.email || '').toLowerCase())) throw new HttpError(403, 'Admin accounts cannot be changed here.');
  if (status === 'suspended' && user.role !== 'coach') throw new HttpError(400, 'Only coaches can be suspended.');

  const stamp = admin.firestore.FieldValue.serverTimestamp();
  await ref.update({
    status,
    statusChangedAt: stamp,
    statusChangedBy: who.email,
    closedAt: status === 'closed' ? stamp : null
  });

  if (user.role === 'coach') {
    await db.collection('coaches').doc(uid).set({ status }, { merge: true });
  } else {
    const owned = await db.collection('clients').where('userId', '==', uid).get();
    for (const d of owned.docs) {
      await d.ref.update(
        status === 'closed'
          ? { accountClosed: true, programmeStatus: 'completed', completedAt: stamp }
          : { accountClosed: false, programmeStatus: 'active', completedAt: null }
      );
    }
  }

  await audit(db, who, 'user-status', uid, `${user.status || 'active'} -> ${status}`);
  return { ok: true };
}

async function emailLog(db) {
  const list = await readAll(db, 'scheduledEmails');
  const sorted = list
    .sort((a, b) => String(b.sendOn || '').localeCompare(String(a.sendOn || '')) || time(b.createdAt) - time(a.createdAt))
    .slice(0, MAX_EMAILS);

  const coachIds = [...new Set(sorted.map((m) => m.coachId).filter(Boolean))];
  const names = {};
  await Promise.all(
    coachIds.map(async (id) => {
      const snap = await db.collection('users').doc(id).get();
      names[id] = snap.exists ? snap.data().displayName || snap.data().email || id : id;
    })
  );

  return {
    emails: sorted.map((m) => ({
      id: m.id,
      kind: m.kind || '',
      audience: m.audience || '',
      status: m.status || '',
      sendOn: m.sendOn || '',
      subject: m.subject || '',
      to: m.toPreview || '',
      error: m.error || '',
      coachId: m.coachId || '',
      coachName: names[m.coachId] || '',
      sentAt: iso(m.sentAt),
      createdAt: iso(m.createdAt)
    }))
  };
}

async function retryEmail(db, body, who) {
  const ref = db.collection('scheduledEmails').doc(String(body.id || '_'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Email not found.');
  const mail = snap.data();
  if (!['failed', 'expired'].includes(mail.status)) throw new HttpError(409, 'Only failed or expired emails can be retried.');
  await ref.update({
    status: 'scheduled',
    sendOn: todayKey(process.env.TIMEZONE || 'Europe/Tallinn'),
    error: null,
    // An expired yearly message already queued next year's copy, so do not queue another one
    recurring: mail.status === 'expired' ? false : !!mail.recurring
  });
  await audit(db, who, 'email-retry', snap.id, mail.status);
  return { ok: true };
}

async function cancelEmail(db, body, who) {
  const ref = db.collection('scheduledEmails').doc(String(body.id || '_'));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Email not found.');
  if (snap.data().status !== 'scheduled') throw new HttpError(409, 'Only scheduled emails can be cancelled.');
  await ref.update({ status: 'cancelled' });
  await audit(db, who, 'email-cancel', snap.id, null);
  return { ok: true };
}

async function billing(db) {
  const [userList, subs, payments] = await Promise.all([
    readAll(db, 'users'),
    readAll(db, 'subscriptions'),
    readAll(db, 'payments')
  ]);
  const byId = Object.fromEntries(userList.map((u) => [u.id, u]));
  const label = (id) => (byId[id] ? byId[id].displayName || byId[id].email || id : id);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const paid = payments.filter((p) => p.status === 'paid');
  const activeSubs = subs.filter((s) => s.status === 'active');
  const coaches = userList.filter((u) => u.role === 'coach');
  const withPlan = new Set(activeSubs.map((s) => s.id));
  const perPlan = {};
  activeSubs.forEach((s) => {
    perPlan[s.planName || s.planId || 'Unknown'] = (perPlan[s.planName || s.planId || 'Unknown'] || 0) + 1;
  });

  return {
    totals: {
      monthlyRecurring: activeSubs.reduce((sum, s) => sum + (Number(s.price) || 0), 0),
      invoicedThisMonth: paid
        .filter((p) => time(p.createdAt) >= monthStart.getTime())
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
      invoicedAllTime: paid.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
      payingCoaches: activeSubs.filter((s) => Number(s.price) > 0).length,
      coachesWithoutPlan: coaches.filter((c) => !withPlan.has(c.id)).length,
      perPlan
    },
    subscriptions: subs
      .map((s) => ({
        coachId: s.id,
        coachName: label(s.id),
        email: byId[s.id] ? byId[s.id].email || '' : '',
        planName: s.planName || '',
        price: Number(s.price) || 0,
        currency: s.currency || 'EUR',
        status: s.status || '',
        nextBillingDate: iso(s.nextBillingDate),
        mode: s.mode || ''
      }))
      .sort((a, b) => a.coachName.localeCompare(b.coachName)),
    invoices: payments
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
      .slice(0, MAX_INVOICES)
      .map((p) => ({
        id: p.id,
        invoiceNumber: p.invoiceNumber || '',
        coachId: p.coachId || '',
        coachName: label(p.coachId),
        planName: p.planName || '',
        amount: Number(p.amount) || 0,
        currency: p.currency || 'EUR',
        status: p.status || '',
        mode: p.mode || '',
        methodLabel: p.methodLabel || '',
        createdAt: iso(p.createdAt)
      }))
  };
}

const ACTIONS = {
  overview: (db) => overview(db),
  messages: (db) => messages(db),
  setMessageStatus,
  users: (db) => users(db),
  setUserStatus,
  emailLog: (db) => emailLog(db),
  retryEmail,
  cancelEmail,
  billing: (db) => billing(db)
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const who = await identify(req);
    if (!who) return res.status(401).json({ error: 'Please sign in again.' });

    const body = req.body || {};
    const action = String(body.action || '');

    // Anyone signed in may ask "am I an admin?". The answer is just yes or no.
    if (action === 'whoami') return res.status(200).json({ admin: who.isAdmin });

    if (!who.isAdmin) return res.status(403).json({ error: 'Not allowed.' });
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return res.status(400).json({ error: 'Unknown action.' });

    const result = await ACTIONS[action](getDb(), body, who);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('admin endpoint failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
