const { sql } = require('@vercel/postgres');

function normalizePhone(raw) {
  let p = (raw || '').trim().replace(/[\s\-\.]/g, '');
  if (p.startsWith('+33')) p = '0' + p.slice(3);
  if (p.startsWith('0033')) p = '0' + p.slice(4);
  return p;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const { date, time, phone } = req.body || {};
  if (!date || !time || !phone) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const phoneNorm = normalizePhone(phone);

  try {
    // Supprimer uniquement si le numéro normalisé correspond — protection contre suppression par tiers
    await sql`
      DELETE FROM appointments
      WHERE date = ${date}
        AND time_slot = ${time}
        AND phone_norm = ${phoneNorm}
        AND status = 'booked'
    `;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[cancel] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
