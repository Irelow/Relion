const { sql } = require('@vercel/postgres');
const { Resend } = require('resend');

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

  // Vérifier format date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date invalide' });
  }

  // Vérifier que c'est un jour ouvrable (lundi-vendredi)
  const d = new Date(date + 'T12:00:00');
  const dow = d.getDay();
  if (dow === 0 || dow === 6) {
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
    // Insérer le rendez-vous (échoue si déjà pris grâce à UNIQUE)
    await sql`
      INSERT INTO appointments (date, time_slot, name, phone, email, status)
      VALUES (${date}, ${time}, ${name}, ${phone}, ${email || ''}, 'booked')
    `;

    // Email de confirmation à l'artisan
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });

      // Email à l'artisan
      if (email) {
        resend.emails.send({
          from: 'Relion <onboarding@resend.dev>',
          to: email,
          subject: `Rendez-vous confirmé — ${dateLabel} à ${time}`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
              <h2>Votre rendez-vous est confirmé ✓</h2>
              <p>Bonjour ${name},</p>
              <p>Votre appel téléphonique avec l'équipe Relion est planifié :</p>
              <div style="background:#f5f5f5;padding:16px;border-radius:8px;margin:20px 0;">
                <p><strong>📅 Date :</strong> ${dateLabel}</p>
                <p><strong>⏰ Heure :</strong> ${time}</p>
                <p><strong>📞 Numéro :</strong> ${phone}</p>
              </div>
              <p>Nous vous appellerons à l'heure prévue. À bientôt !</p>
              <p>— L'équipe Relion</p>
            </div>
          `
        }).catch(() => {});
      }

      // Email à Alix (notification interne)
      resend.emails.send({
        from: 'Relion <onboarding@resend.dev>',
        to: 'alix.sarikabadayi@gmail.com',
        subject: `📅 Nouveau RDV — ${name} le ${dateLabel} à ${time}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <h2>Nouveau rendez-vous 📞</h2>
            <p><strong>Nom :</strong> ${name}</p>
            <p><strong>Téléphone :</strong> ${phone}</p>
            <p><strong>Email :</strong> ${email || 'non renseigné'}</p>
            <p><strong>Date :</strong> ${dateLabel} à ${time}</p>
          </div>
        `
      }).catch(() => {});
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    // Erreur de contrainte unique = créneau déjà pris
    if (err.message && err.message.includes('unique')) {
      return res.status(409).json({ error: 'Ce creneau est deja pris' });
    }
    console.error('[book] Erreur:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
