const { sql } = require('@vercel/postgres');

// Endpoint admin pour gérer les rendez-vous
// Protégé par x-setup-key header
//
// Actions disponibles :
//   list        : lister les RDV d'une date  { action: 'list', date: 'YYYY-MM-DD' }
//   block       : bloquer un créneau         { action: 'block', date, time }
//   unblock     : libérer un créneau         { action: 'unblock', date, time }
//   cancel      : annuler un RDV artisan     { action: 'cancel', date, time }
//   block_day   : bloquer toute une journée  { action: 'block_day', date }
//   unblock_day : libérer toute une journée  { action: 'unblock_day', date }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-setup-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.headers['x-setup-key'] !== process.env.SETUP_KEY) {
    return res.status(403).json({ error: 'Acces refuse' });
  }

  const body = req.method === 'GET' ? req.query : (req.body || {});
  const { action, date, time } = body;

  if (!action) {
    return res.status(400).json({ error: 'Action requise', actions: ['list', 'block', 'unblock', 'cancel', 'block_day', 'unblock_day'] });
  }

  try {
    switch (action) {
      case 'list': {
        if (!date) return res.status(400).json({ error: 'date requis' });
        const { rows } = await sql`
          SELECT time_slot, name, phone, email, status, created_at
          FROM appointments WHERE date = ${date}
          ORDER BY time_slot
        `;
        return res.status(200).json({ date, appointments: rows });
      }

      case 'block': {
        if (!date || !time) return res.status(400).json({ error: 'date et time requis' });
        await sql`
          INSERT INTO appointments (date, time_slot, status)
          VALUES (${date}, ${time}, 'blocked')
          ON CONFLICT (date, time_slot) DO UPDATE SET status = 'blocked'
        `;
        return res.status(200).json({ success: true, message: `Creneau ${date} ${time} bloque` });
      }

      case 'unblock': {
        if (!date || !time) return res.status(400).json({ error: 'date et time requis' });
        await sql`DELETE FROM appointments WHERE date = ${date} AND time_slot = ${time}`;
        return res.status(200).json({ success: true, message: `Creneau ${date} ${time} libere` });
      }

      case 'cancel': {
        if (!date || !time) return res.status(400).json({ error: 'date et time requis' });
        await sql`DELETE FROM appointments WHERE date = ${date} AND time_slot = ${time} AND status = 'booked'`;
        return res.status(200).json({ success: true, message: `RDV ${date} ${time} annule` });
      }

      case 'block_day': {
        if (!date) return res.status(400).json({ error: 'date requis' });
        const SLOTS = ['09:00','09:30','10:00','10:30','11:00','11:30','14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'];
        for (const s of SLOTS) {
          await sql`
            INSERT INTO appointments (date, time_slot, status)
            VALUES (${date}, ${s}, 'blocked')
            ON CONFLICT (date, time_slot) DO NOTHING
          `;
        }
        return res.status(200).json({ success: true, message: `Journee ${date} bloquee` });
      }

      case 'unblock_day': {
        if (!date) return res.status(400).json({ error: 'date requis' });
        await sql`DELETE FROM appointments WHERE date = ${date} AND status = 'blocked'`;
        return res.status(200).json({ success: true, message: `Journee ${date} liberee` });
      }

      default:
        return res.status(400).json({ error: 'Action inconnue' });
    }
  } catch (err) {
    console.error('[manage] Erreur:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
