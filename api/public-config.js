// Vercel serverless function: settings that every visitor needs, signed in or not.
//   GET  /api/public-config          -> maintenance message, seasonal theme, plans, partners
//   POST /api/public-config {action:'visit'} -> counts one page visit for today (anonymous, totals only)
// Nothing here identifies a person.

const { admin, getDb } = require('./_lib');

const DEFAULT_MAINTENANCE = { enabled: false, message: '' };

module.exports = async (req, res) => {
  try {
    const db = getDb();

    if (req.method === 'POST') {
      const action = String((req.body && req.body.action) || '');
      if (action !== 'visit') return res.status(400).json({ error: 'Unknown action.' });
      const day = new Date().toISOString().slice(0, 10);
      await db.collection('visitStats').doc(day).set(
        { count: admin.firestore.FieldValue.increment(1), updatedAt: new Date().toISOString() },
        { merge: true }
      );
      return res.status(200).json({ ok: true });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET or POST' });

    const [site, plans, partners] = await Promise.all([
      db.collection('settings').doc('site').get(),
      db.collection('settings').doc('plans').get(),
      db.collection('settings').doc('partners').get()
    ]);
    const siteData = site.exists ? site.data() : {};
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      season: siteData.season || 'default',
      maintenance: siteData.maintenance || DEFAULT_MAINTENANCE,
      plans: plans.exists ? plans.data().plans : null,
      partners: partners.exists ? partners.data().partners : null
    });
  } catch (err) {
    console.error('public-config failed:', err);
    // Visitors still get the site with default settings if the database is unreachable
    if (req.method === 'GET') {
      return res.status(200).json({ season: 'default', maintenance: DEFAULT_MAINTENANCE, plans: null, partners: null });
    }
    return res.status(500).json({ error: 'Could not record this.' });
  }
};
