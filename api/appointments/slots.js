const { sql } = require('@vercel/postgres');
 
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Methode non autorisee' });
 
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date invalide (format: YYYY-MM-DD)' });
  }
 
  try {
    const { rows } = await sql`
      SELECT time_slot FROM appointments
      WHERE date = ${date} AND status IN ('booked', 'blocked')
    `;
    const booked = rows.map(r => r.time_slot);
    return res.status(200).json({ booked });
  } catch (err) {
    console.error('[slots] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
