// Shared helpers for the CoachFlow serverless functions.
// Files that start with an underscore are not exposed as endpoints by Vercel.

const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  return admin.firestore();
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

module.exports = { admin, getDb, toHtml, sendWithResend };
