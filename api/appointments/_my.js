const { sql } = require('@vercel/postgres');

// Retourne le rendez-vous actif d'un numéro de téléphone
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Methode non autorisee' });

  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone requis' });

  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await sql`
      SELECT date, time_slot, name
      FROM appointments
      WHERE phone = ${phone.trim()} AND status = 'booked' AND date >= ${today}
      ORDER BY date ASC, time_slot ASC
      LIMIT 1
    `;
    return res.status(200).json({ appointment: rows[0] || null });
  } catch (err) {
    console.error('[my] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
