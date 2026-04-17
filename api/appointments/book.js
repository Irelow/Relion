const { sql } = require('@vercel/postgres');
const { Resend } = require('resend');

// Normalise un numéro : retire espaces/points/tirets, convertit +33/0033 en 0
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

  const { date, time, name, phone, email } = req.body || {};
  if (!date || !time || !name || !phone) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  // Valider format date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date invalide' });
  }

  // Normaliser + valider le numéro
  const phoneNorm = normalizePhone(phone);
  if (!/^(0|\+33)[0-9]{9}$/.test(phoneNorm) && !/^[0-9]{8,15}$/.test(phoneNorm)) {
    return res.status(400).json({ error: 'Numero de telephone invalide' });
  }

  // Vérifier que c'est un jour ouvrable (lundi-vendredi)
  const d = new Date(date + 'T12:00:00');
  if (d.getDay() === 0 || d.getDay() === 6) {
    return res.status(400).json({ error: 'Jour non disponible' });
  }

  // Créneaux autorisés
  const VALID_SLOTS = [
    '09:00','09:30','10:00','10:30','11:00','11:30',
    '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'
  ];
  if (!VALID_SLOTS.includes(time)) {
    return res.status(400).json({ error: 'Creneau invalide' });
  }

  try {
    // ── Un seul RDV actif par numéro (normalisé) ──────────────────────
    const today = new Date().toISOString().split('T')[0];
    const existing = await sql`
      SELECT date, time_slot FROM appointments
      WHERE phone_norm = ${phoneNorm}
        AND status = 'booked'
        AND date >= ${today}
      ORDER BY date ASC LIMIT 1
    `;
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Vous avez deja un rendez-vous.',
        existing: existing.rows[0]
      });
    }

    // ── Insérer (UNIQUE(date, time_slot) protège le créneau) ──────────
    await sql`
      INSERT INTO appointments (date, time_slot, name, phone, phone_norm, email, status)
      VALUES (${date}, ${time}, ${name.trim()}, ${phone.trim()}, ${phoneNorm}, ${email || ''}, 'booked')
    `;

    // ── Emails de confirmation ─────────────────────────────────────────
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });

      // Email à l'artisan (si email fourni)
      if (email) {
        resend.emails.send({
          from: 'Relion <noreply@relionapp.fr>',
          to: email,
          subject: `Rendez-vous confirmé — ${dateLabel} à ${time}`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
              <h2 style="font-size:22px;margin-bottom:8px;">Votre rendez-vous est confirmé ✓</h2>
              <p>Bonjour ${name.trim()},</p>
              <p>Votre appel avec l'équipe Relion est planifié :</p>
              <div style="background:#f5f7ff;padding:16px;border-radius:10px;margin:20px 0;">
                <p style="margin:4px 0;"><strong>📅 Date :</strong> ${dateLabel}</p>
                <p style="margin:4px 0;"><strong>⏰ Heure :</strong> ${time}</p>
                <p style="margin:4px 0;"><strong>📞 Numéro :</strong> ${phone.trim()}</p>
              </div>
              <p>Nous vous appellerons à l'heure prévue. À bientôt !</p>
              <p>— L'équipe Relion</p>
            </div>
          `
        }).catch(() => {});
      }

      // Notification interne
      resend.emails.send({
        from: 'Relion <noreply@relionapp.fr>',
        to: 'alix.sarikabadayi@gmail.com',
        subject: `📅 Nouveau RDV — ${name.trim()} le ${dateLabel} à ${time}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
            <h2>Nouveau rendez-vous 📞</h2>
            <p><strong>Nom :</strong> ${name.trim()}</p>
            <p><strong>Téléphone :</strong> ${phone.trim()}</p>
            <p><strong>Email :</strong> ${email || 'non renseigné'}</p>
            <p><strong>Date :</strong> ${dateLabel} à ${time}</p>
          </div>
        `
      }).catch(() => {});
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    // Contrainte unique = créneau déjà pris par quelqu'un d'autre
    if (err.message && err.message.toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Ce creneau est deja pris, choisissez-en un autre.' });
    }
    // Colonne phone_norm manquante → migration nécessaire
    if (err.message && err.message.includes('phone_norm')) {
      return res.status(500).json({ error: 'Migration DB requise — relancez /api/setup-db' });
    }
    console.error('[book] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
