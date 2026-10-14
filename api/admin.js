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
  const db = getDb();
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = String(decoded.email || '').toLowerCase();
    const verified = decoded.email_verified === true && !!email;
    let isAdmin = verified && adminEmails().includes(email);
    if (verified && !isAdmin) {
      // Admins added from the admin page are stored in the "admins" collection (written by the server only)
      const row = await db.collection('admins').doc(email).get();
      isAdmin = row.exists;
    }
    return { uid: decoded.uid, email, isAdmin };
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
  const [userList, clients, subs, adminRows] = await Promise.all([
    readAll(db, 'users'),
    readAll(db, 'clients'),
    readAll(db, 'subscriptions'),
    readAll(db, 'admins')
  ]);
  const adminSet = new Set([...adminEmails(), ...adminRows.map((r) => r.id)]);
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
        isAdmin: adminSet.has(String(u.email || '').toLowerCase()),
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

// ---------------------------------------------------------------------------
// Settings documents (plans, partners, site: season and maintenance)
// ---------------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const cleanText = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

async function readSetting(db, id) {
  const snap = await db.collection('settings').doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function plansGet(db) {
  const row = await readSetting(db, 'plans');
  return { plans: row ? row.plans : null };
}

async function plansSave(db, body, who) {
  if (!Array.isArray(body.plans) || body.plans.length === 0 || body.plans.length > 6) throw new HttpError(400, 'Send between 1 and 6 plans.');
  const plans = body.plans.map((p, i) => {
    const price = Number(p.price);
    if (!Number.isFinite(price) || price < 0 || price > 10000) throw new HttpError(400, `Price for ${p.name || 'a plan'} is not valid.`);
    const name = cleanText(p.name, 40);
    if (!name) throw new HttpError(400, 'Every plan needs a name.');
    const features = (Array.isArray(p.features) ? p.features : String(p.features || '').split('\n'))
      .map((f) => cleanText(f, 120)).filter(Boolean).slice(0, 12);
    return {
      id: cleanText(p.id, 30) || `plan-${i + 1}`,
      name,
      price: Math.round(price * 100) / 100,
      tagline: cleanText(p.tagline, 120),
      features,
      active: p.active !== false
    };
  });
  await db.collection('settings').doc('plans').set({ plans, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: who.email });
  await audit(db, who, 'plans-save', 'settings/plans', plans.map((p) => `${p.name} ${p.price}`).join(', '));
  return { ok: true };
}

async function partnersGet(db) {
  const row = await readSetting(db, 'partners');
  return { partners: row ? row.partners : null };
}

async function partnersSave(db, body, who) {
  if (!Array.isArray(body.partners) || body.partners.length > 50) throw new HttpError(400, 'Invalid partner list.');
  const partners = body.partners.map((p) => {
    const name = cleanText(p.name, 60);
    const url = cleanText(p.url, 200);
    if (!name) throw new HttpError(400, 'Every partner needs a name.');
    if (!/^https:\/\/[^\s]+$/.test(url)) throw new HttpError(400, `The link for ${name} must start with https://`);
    return {
      id: cleanText(p.id, 40) || slugify(name),
      name,
      url,
      description: cleanText(p.description, 200),
      active: p.active !== false
    };
  });
  await db.collection('settings').doc('partners').set({ partners, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: who.email });
  await audit(db, who, 'partners-save', 'settings/partners', partners.map((p) => p.name).join(', '));
  return { ok: true };
}

const slugify = (text) =>
  String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function siteGet(db) {
  const row = await readSetting(db, 'site');
  return { season: row?.season || 'default', maintenance: row?.maintenance || { enabled: false, message: '' } };
}

async function siteSave(db, body, who) {
  const season = String(body.season || 'default');
  if (!['default', 'christmas', 'summer'].includes(season)) throw new HttpError(400, 'Unknown season.');
  const maintenance = {
    enabled: body.maintenance && body.maintenance.enabled === true,
    message: cleanText(body.maintenance && body.maintenance.message, 300) || 'BodUp is undergoing maintenance. Please try again shortly.'
  };
  await db.collection('settings').doc('site').set({ season, maintenance, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: who.email }, { merge: true });
  await audit(db, who, 'site-save', 'settings/site', `season=${season}, maintenance=${maintenance.enabled}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------
async function couponsList(db) {
  const list = await readAll(db, 'coupons');
  return {
    coupons: list
      .sort((a, b) => time(b.createdAt) - time(a.createdAt))
      .map((c) => ({
        code: c.id, type: c.type, value: c.value, validUntil: c.validUntil || null,
        maxUses: c.maxUses || 0, uses: c.uses || 0, active: c.active !== false
      }))
  };
}

async function couponSave(db, body, who) {
  const code = cleanText(body.code, 20).toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw new HttpError(400, 'Codes use 3 to 20 letters, numbers or dashes.');
  const type = body.type === 'amount' ? 'amount' : 'percent';
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100)) throw new HttpError(400, 'Enter a valid discount.');
  const validUntil = body.validUntil ? String(body.validUntil) : null;
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new HttpError(400, 'Expiry date must be a date.');
  const maxUses = Math.max(0, Math.floor(Number(body.maxUses) || 0));
  const ref = db.collection('coupons').doc(code);
  const existing = await ref.get();
  await ref.set({
    code, type, value: Math.round(value * 100) / 100, validUntil, maxUses,
    active: body.active !== false,
    uses: existing.exists ? existing.data().uses || 0 : 0,
    createdAt: existing.exists ? existing.data().createdAt : admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await audit(db, who, 'coupon-save', code, `${type} ${value}`);
  return { ok: true };
}

async function couponToggle(db, body, who) {
  const ref = db.collection('coupons').doc(cleanText(body.code, 20).toUpperCase());
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Coupon not found.');
  await ref.update({ active: body.active === true });
  await audit(db, who, 'coupon-toggle', snap.id, body.active === true ? 'on' : 'off');
  return { ok: true };
}

// Checks a code against the plan price. Used by coaches at checkout and by the admin to test.
async function checkCoupon(db, code, planId) {
  const snap = await db.collection('coupons').doc(cleanText(code, 20).toUpperCase()).get();
  if (!snap.exists) return { valid: false, reason: 'This code does not exist.' };
  const c = snap.data();
  if (c.active === false) return { valid: false, reason: 'This code is no longer active.' };
  if (c.validUntil && c.validUntil < today()) return { valid: false, reason: 'This code has expired.' };
  if (c.maxUses > 0 && (c.uses || 0) >= c.maxUses) return { valid: false, reason: 'This code has been used up.' };
  const plansRow = await readSetting(db, 'plans');
  const plans = plansRow ? plansRow.plans : [];
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return { valid: false, reason: 'Choose a plan first.' };
  const price = Number(plan.price) || 0;
  const discounted = c.type === 'percent'
    ? Math.round(price * (1 - c.value / 100) * 100) / 100
    : Math.max(0, Math.round((price - c.value) * 100) / 100);
  return {
    valid: true,
    code: snap.id,
    price,
    discounted,
    label: c.type === 'percent' ? `${c.value}% off` : `${c.value} EUR off`
  };
}

async function couponCheck(db, body) {
  return checkCoupon(db, body.code, body.planId);
}

async function couponRedeem(db, body) {
  const result = await checkCoupon(db, body.code, body.planId);
  if (!result.valid) throw new HttpError(409, result.reason);
  await db.collection('coupons').doc(result.code).update({ uses: admin.firestore.FieldValue.increment(1) });
  return { ok: true, discounted: result.discounted };
}

// ---------------------------------------------------------------------------
// Customers overview: coaches, their clients, gyms and plans
// ---------------------------------------------------------------------------
async function customers(db) {
  const [userList, clients, profiles, subs] = await Promise.all([
    readAll(db, 'users'), readAll(db, 'clients'), readAll(db, 'profiles'), readAll(db, 'subscriptions')
  ]);
  const profileById = Object.fromEntries(profiles.map((p) => [p.id, p]));
  const planOf = Object.fromEntries(subs.map((s) => [s.id, s]));
  const coaches = userList.filter((u) => u.role === 'coach');
  const gymCounts = {};
  const coachRows = coaches.map((c) => {
    const mine = clients.filter((k) => k.coachId === c.id);
    const gyms = {};
    mine.forEach((k) => {
      const gym = k.userId && profileById[k.userId] && profileById[k.userId].gym;
      if (gym) {
        gyms[gym] = (gyms[gym] || 0) + 1;
        gymCounts[gym] = (gymCounts[gym] || 0) + 1;
      }
    });
    const sub = planOf[c.id];
    return {
      uid: c.id,
      name: c.displayName || '',
      email: c.email || '',
      status: c.status || 'active',
      plan: sub ? `${sub.planName} (${sub.status})` : 'No plan',
      price: sub ? Number(sub.price) || 0 : 0,
      clients: mine.length,
      joined: mine.filter((k) => k.userId).length,
      gyms: Object.entries(gyms).map(([name, count]) => ({ name, count }))
    };
  }).sort((a, b) => b.clients - a.clients);

  const nameOfCoach = Object.fromEntries(coaches.map((c) => [c.id, c.displayName || c.email || '']));
  return {
    totals: {
      coaches: coaches.length,
      clients: clients.length,
      joinedClients: clients.filter((k) => k.userId).length,
      payingCoaches: subs.filter((s) => s.status === 'active' && Number(s.price) > 0).length,
      gyms: Object.keys(gymCounts).length
    },
    coaches: coachRows,
    clients: clients.map((k) => ({
      id: k.id,
      name: k.name || '',
      coachName: nameOfCoach[k.coachId] || '',
      joined: !!k.userId,
      gym: (k.userId && profileById[k.userId] && profileById[k.userId].gym) || '',
      status: k.programmeStatus === 'completed' ? 'completed' : (k.userId ? 'active' : 'pending')
    })).sort((a, b) => a.coachName.localeCompare(b.coachName)),
    gyms: Object.entries(gymCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    companies: []
  };
}

// ---------------------------------------------------------------------------
// Visits (anonymous daily totals only, no personal data)
// ---------------------------------------------------------------------------
async function visitsStats(db) {
  const snap = await db.collection('visitStats').orderBy(admin.firestore.FieldPath.documentId(), 'desc').limit(60).get();
  const days = snap.docs.map((d) => ({ date: d.id, count: d.data().count || 0 }));
  const sum = (n) => days.slice(0, n).reduce((t, d) => t + d.count, 0);
  return { days: days.slice(0, 30).reverse(), today: days.find((d) => d.date === today())?.count || 0, last7: sum(7), last30: sum(30) };
}

// ---------------------------------------------------------------------------
// Admins: invite by email, remove, promote and demote registered accounts
// ---------------------------------------------------------------------------
async function adminsList(db) {
  const rows = await readAll(db, 'admins');
  const fromEnv = adminEmails().map((email) => ({ email, source: 'Set in Vercel (cannot be removed here)' }));
  return {
    admins: [
      ...fromEnv,
      ...rows.filter((r) => !adminEmails().includes(r.id)).map((r) => ({ email: r.id, source: 'Added by admin' }))
    ]
  };
}

async function adminInvite(db, body, who) {
  const email = cleanText(body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (adminEmails().includes(email)) throw new HttpError(409, 'This person is already an admin.');
  await db.collection('admins').doc(email).set({ email, addedBy: who.email, addedAt: admin.firestore.FieldValue.serverTimestamp() });
  await audit(db, who, 'admin-add', email, null);
  return { ok: true };
}

async function adminRemove(db, body, who) {
  const email = cleanText(body.email, 200).toLowerCase();
  if (adminEmails().includes(email)) throw new HttpError(403, 'Admins set in Vercel cannot be removed here.');
  if (email === who.email) throw new HttpError(403, 'You cannot remove your own admin access.');
  await db.collection('admins').doc(email).delete();
  await audit(db, who, 'admin-remove', email, null);
  return { ok: true };
}

async function setAdminForUser(db, body, who) {
  const user = await db.collection('users').doc(String(body.uid || '_')).get();
  if (!user.exists) throw new HttpError(404, 'User not found.');
  const email = String(user.data().email || '').toLowerCase();
  if (!email) throw new HttpError(400, 'This account has no email address.');
  if (body.admin === true) return adminInvite(db, { email }, who);
  return adminRemove(db, { email }, who);
}

// ---------------------------------------------------------------------------
// Chat between coaches and the admin (one thread per coach)
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

async function threadFor(db, coachId) {
  const snap = await db.collection('adminChats').doc(coachId).get();
  return snap.exists ? snap.data() : { messages: [], unreadAdmin: false, unreadCoach: false };
}

async function chatGet(db, body, who) {
  const thread = await threadFor(db, who.uid);
  if (thread.unreadCoach) await db.collection('adminChats').doc(who.uid).update({ unreadCoach: false });
  return { messages: thread.messages || [] };
}

async function chatSend(db, body, who) {
  const text = cleanText(body.text, 2000);
  if (!text) throw new HttpError(400, 'Write a message first.');
  const coach = (await db.collection('users').doc(who.uid).get()).data() || {};
  const thread = await threadFor(db, who.uid);
  const messages = [...(thread.messages || []), { from: 'coach', text, at: nowIso() }].slice(-200);
  await db.collection('adminChats').doc(who.uid).set({
    coachId: who.uid, coachName: coach.displayName || '', email: coach.email || who.email,
    messages, unreadAdmin: true, unreadCoach: false, updatedAt: nowIso()
  }, { merge: true });
  return { messages };
}

async function chatList(db) {
  const rows = await readAll(db, 'adminChats');
  return {
    threads: rows
      .map((t) => ({
        coachId: t.id, coachName: t.coachName || t.email || t.id, email: t.email || '',
        last: (t.messages || []).slice(-1)[0] || null, unreadAdmin: !!t.unreadAdmin, updatedAt: t.updatedAt || ''
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  };
}

async function chatThread(db, body) {
  const thread = await threadFor(db, String(body.coachId || '_'));
  if (thread.unreadAdmin) await db.collection('adminChats').doc(String(body.coachId)).update({ unreadAdmin: false });
  return { messages: thread.messages || [], coachName: thread.coachName || '' };
}

async function chatReply(db, body, who) {
  const coachId = String(body.coachId || '_');
  const text = cleanText(body.text, 2000);
  if (!text) throw new HttpError(400, 'Write a reply first.');
  const thread = await threadFor(db, coachId);
  const messages = [...(thread.messages || []), { from: 'admin', text, at: nowIso() }].slice(-200);
  await db.collection('adminChats').doc(coachId).set({ messages, unreadCoach: true, unreadAdmin: false, updatedAt: nowIso() }, { merge: true });
  await audit(db, who, 'chat-reply', coachId, null);
  return { messages };
}

// ---------------------------------------------------------------------------
// Actions that coaches may use (everything else needs the admin)
// ---------------------------------------------------------------------------
const COACH_ACTIONS = new Set(['chatGet', 'chatSend', 'couponCheck', 'couponRedeem']);

const ACTIONS = {
  overview: (db) => overview(db),
  messages: (db) => messages(db),
  setMessageStatus,
  users: (db) => users(db),
  setUserStatus,
  emailLog: (db) => emailLog(db),
  retryEmail,
  cancelEmail,
  billing: (db) => billing(db),
  customers: (db) => customers(db),
  couponsList: (db) => couponsList(db),
  couponSave,
  couponToggle,
  couponCheck,
  couponRedeem,
  plansGet: (db) => plansGet(db),
  plansSave,
  partnersGet: (db) => partnersGet(db),
  partnersSave,
  siteGet: (db) => siteGet(db),
  siteSave,
  visitsStats: (db) => visitsStats(db),
  adminsList: (db) => adminsList(db),
  adminInvite,
  adminRemove,
  setAdminForUser,
  chatList: (db) => chatList(db),
  chatThread,
  chatReply,
  chatGet,
  chatSend
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

    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return res.status(400).json({ error: 'Unknown action.' });

    if (!who.isAdmin) {
      // Coaches may use only their own chat and coupon checks, and only while their account is active
      if (!COACH_ACTIONS.has(action)) return res.status(403).json({ error: 'Not allowed.' });
      const row = await getDb().collection('users').doc(who.uid).get();
      const u = row.exists ? row.data() : null;
      if (!u || u.role !== 'coach' || u.status === 'closed' || u.status === 'suspended') {
        return res.status(403).json({ error: 'Not allowed.' });
      }
    }

    const result = await ACTIONS[action](getDb(), body, who);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error('admin endpoint failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
