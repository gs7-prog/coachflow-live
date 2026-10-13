// Vercel serverless function: the coach clicks "Send reminder" on a client who has not joined yet,
// and this sends the invitation reminder straight away.
//
// Safety:
//   - the caller must be a signed-in coach (Firebase ID token is verified here)
//   - the client must belong to that coach and must not have joined yet
//   - limits: 5 reminders per client, at least 10 minutes apart, 25 reminder emails per coach per day

const { admin, getDb, sendWithResend } = require('./_lib');

const MAX_PER_CLIENT = 5;
const MIN_GAP_MINUTES = 10;
const MAX_PER_DAY = 25;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
      return res.status(500).json({ error: 'Email sending is not set up yet (see SETUP.md).' });
    }

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Please sign in again.' });

    const db = getDb();
    let uid;
    try {
      uid = (await admin.auth().verifyIdToken(token)).uid;
    } catch (err) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    const body = req.body || {};
    const email = String(body.email || '').trim();
    const subject = String(body.subject || '').trim();
    const text = String(body.body || '').trim();
    if (!EMAIL_PATTERN.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!subject || subject.length > 150) return res.status(400).json({ error: 'The subject is empty or too long.' });
    if (!text || text.length > 5000) return res.status(400).json({ error: 'The message is empty or too long.' });

    const coachSnap = await db.collection('users').doc(uid).get();
    const coach = coachSnap.exists ? coachSnap.data() : null;
    if (!coach || coach.role !== 'coach' || coach.status === 'closed' || coach.status === 'suspended') {
      return res.status(403).json({ error: 'Only an active coach can send reminders.' });
    }

    const clientRef = db.collection('clients').doc(String(body.clientId || '_'));
    const clientSnap = await clientRef.get();
    const client = clientSnap.exists ? clientSnap.data() : null;
    if (!client || client.coachId !== uid) return res.status(403).json({ error: 'This client is not yours.' });
    if (client.userId) return res.status(409).json({ error: 'This client has already joined.' });

    const sent = client.inviteReminders || {};
    if ((sent.count || 0) >= MAX_PER_CLIENT) {
      return res.status(429).json({ error: `You have already sent ${MAX_PER_CLIENT} reminders to this client.` });
    }
    const last = sent.lastSentAt && sent.lastSentAt.toDate ? sent.lastSentAt.toDate() : null;
    if (last && Date.now() - last.getTime() < MIN_GAP_MINUTES * 60000) {
      return res.status(429).json({ error: `Please wait ${MIN_GAP_MINUTES} minutes between reminders.` });
    }

    const today = new Date().toISOString().slice(0, 10);
    const limitRef = db.collection('rateLimits').doc(uid);
    const limitSnap = await limitRef.get();
    const limit = limitSnap.exists ? limitSnap.data() : {};
    const sentToday = limit.day === today ? limit.count || 0 : 0;
    if (sentToday >= MAX_PER_DAY) {
      return res.status(429).json({ error: 'You have reached the daily limit for reminder emails.' });
    }

    await sendWithResend({
      to: email,
      subject,
      text,
      fromName: coach.displayName || 'Your coach',
      replyTo: coach.email
    });

    await limitRef.set({ day: today, count: sentToday + 1 });
    await clientRef.update({
      inviteEmail: email,
      inviteReminders: {
        count: (sent.count || 0) + 1,
        lastSentAt: admin.firestore.FieldValue.serverTimestamp()
      }
    });

    return res.status(200).json({ ok: true, count: (sent.count || 0) + 1 });
  } catch (err) {
    console.error('send-invite-reminder failed:', err);
    return res.status(500).json({ error: 'Could not send the reminder. Try again in a moment.' });
  }
};
