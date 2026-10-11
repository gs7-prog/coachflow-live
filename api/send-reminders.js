// Vercel serverless function: sends every due email in the "scheduledEmails" collection.
// Runs once a day from the cron job in vercel.json. See SETUP.md for the environment variables.
//
// The app stores the exact subject and text the coach previewed. This function only decides
// WHO receives it, and it works that out from the database, never from the document itself:
//   - coach reminders go to the coach's own account email
//   - client emails go to the email of the client's own user account, and only if the client
//     belongs to the coach who created the email, and (for greetings) is still opted in.

const admin = require('firebase-admin');

const MAX_PER_RUN = 200;
const MAX_LATE_DAYS = 3;

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin.firestore();
}

// YYYY-MM-DD for "today" in the configured time zone
function todayKey(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function dayDiff(a, b) {
  const utc = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(a) - utc(b)) / 86400000);
}

// Same date next year (29 Feb becomes 28 Feb)
function nextYearKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  let date = new Date(Date.UTC(y + 1, m - 1, d));
  if (date.getUTCMonth() !== m - 1) date = new Date(Date.UTC(y + 1, m - 1, d - 1));
  return date.toISOString().slice(0, 10);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toHtml(text) {
  const linked = escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#4f46e5">$1</a>'
  );
  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1c1e4a">' +
    linked.replace(/\n/g, '<br>') +
    '</div>'
  );
}

async function sendWithResend({ to, subject, text, fromName, replyTo }) {
  const safeName = String(fromName || 'CoachFlow').replace(/[<>"]/g, '').slice(0, 60);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: `${safeName} via CoachFlow <${process.env.FROM_EMAIL}>`,
      to: [to],
      subject,
      text,
      html: toHtml(text),
      reply_to: replyTo || undefined
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend ${response.status}: ${detail.slice(0, 200)}`);
  }
}

// Works out who may receive this email, or explains why nobody should
async function resolveRecipient(db, mail, cache) {
  const getDoc = async (collection, id) => {
    const key = `${collection}/${id}`;
    if (!cache.has(key)) {
      const snap = await db.collection(collection).doc(id).get();
      cache.set(key, snap.exists ? snap.data() : null);
    }
    return cache.get(key);
  };

  const coachUser = await getDoc('users', mail.coachId);
  if (!coachUser || coachUser.role !== 'coach') return { error: 'Coach account not found' };
  if (coachUser.status === 'closed') return { error: 'Coach account is closed' };

  if (mail.audience === 'coach') {
    return coachUser.email ? { email: coachUser.email } : { error: 'Coach has no email address' };
  }

  const client = await getDoc('clients', mail.clientId);
  if (!client || client.coachId !== mail.coachId) return { error: 'Client does not belong to this coach' };
  if (!client.userId) return { error: 'Client has not joined yet' };

  if (mail.kind === 'birthday' || mail.kind === 'christmas' || mail.kind === 'partner') {
    const optKey = mail.kind === 'partner' ? mail.partnerId : mail.kind;
    if (!client.optIns || !client.optIns[optKey] || client.optIns[optKey].enabled !== true) {
      return { error: 'Client is no longer opted in', skip: true };
    }
  }

  const clientUser = await getDoc('users', client.userId);
  if (!clientUser || !clientUser.email) return { error: 'Client has no email address' };
  return { email: clientUser.email };
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query && req.query.dry === '1';
  const result = { dryRun, today: null, checked: 0, sent: 0, failed: 0, skipped: 0, expired: 0, details: [] };

  try {
    if (!dryRun && (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL)) {
      throw new Error('RESEND_API_KEY and FROM_EMAIL must be set');
    }

    const db = getDb();
    const today = todayKey(process.env.TIMEZONE || 'Europe/Tallinn');
    result.today = today;
    const cache = new Map();

    const snap = await db.collection('scheduledEmails').where('status', '==', 'scheduled').get();
    const due = snap.docs.filter((d) => d.data().sendOn && d.data().sendOn <= today).slice(0, MAX_PER_RUN);
    result.checked = due.length;

    for (const docSnap of due) {
      const mail = docSnap.data();
      const ref = docSnap.ref;
      const label = `${mail.kind} ${docSnap.id}`;

      const queueNextYear = async () => {
        if (mail.recurring) {
          await db.collection('scheduledEmails').add({
            ...mail,
            sendOn: nextYearKey(mail.sendOn),
            status: 'scheduled',
            sentAt: null,
            error: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      };

      try {
        if (dayDiff(today, mail.sendOn) > MAX_LATE_DAYS) {
          result.expired += 1;
          result.details.push({ id: docSnap.id, kind: mail.kind, outcome: 'expired' });
          if (!dryRun) {
            await ref.update({ status: 'expired' });
            await queueNextYear();
          }
          continue;
        }

        const recipient = await resolveRecipient(db, mail, cache);
        if (recipient.error) {
          if (recipient.skip) {
            result.skipped += 1;
            result.details.push({ id: docSnap.id, kind: mail.kind, outcome: `skipped: ${recipient.error}` });
            if (!dryRun) await ref.update({ status: 'cancelled', error: recipient.error });
          } else {
            result.failed += 1;
            result.details.push({ id: docSnap.id, kind: mail.kind, outcome: `failed: ${recipient.error}` });
            if (!dryRun) await ref.update({ status: 'failed', error: recipient.error });
          }
          continue;
        }

        if (dryRun) {
          result.details.push({ id: docSnap.id, kind: mail.kind, outcome: 'would send', to: recipient.email });
          continue;
        }

        await sendWithResend({
          to: recipient.email,
          subject: mail.subject,
          text: mail.body,
          fromName: mail.fromName,
          replyTo: mail.audience === 'coach' ? undefined : mail.replyTo
        });
        await ref.update({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp(), error: null });
        await queueNextYear();
        result.sent += 1;
        result.details.push({ id: docSnap.id, kind: mail.kind, outcome: 'sent' });
      } catch (err) {
        result.failed += 1;
        result.details.push({ id: docSnap.id, kind: mail.kind, outcome: `failed: ${err.message}` });
        if (!dryRun) {
          await ref.update({ status: 'failed', error: String(err.message).slice(0, 300) }).catch(() => {});
        }
        console.error(`Could not send ${label}:`, err);
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('send-reminders failed:', err);
    return res.status(500).json({ error: err.message });
  }
};
