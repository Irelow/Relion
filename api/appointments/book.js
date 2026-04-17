const { sql } = require('@vercel/postgres');
const { Resend } = require('resend');

function normalizePhone(raw) {
  let p = (raw || '').trim().replace(/[\s\-\.]/g, '');
  if (p.startsWith('+33')) p = '0' + p.slice(3);
  if (p.startsWith('0033')) p = '0' + p.slice(4);
  return p;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const { step, date, time, name, phone, email, code } = req.body || {};

  // ── Migrations automatiques ────────────────────────────────────────────
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS phone_norm VARCHAR(20)`.catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_appointments_phone_norm ON appointments(phone_norm)`.catch(() => {});
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS verification_code VARCHAR(6)`.catch(() => {});
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS code_expires_at TIMESTAMPTZ`.catch(() => {});

  // ══════════════════════════════════════════════════════════════════════
  // ÉTAPE 1 : Demande de code — valider + envoyer l'email
  // ══════════════════════════════════════════════════════════════════════
  if (!step || step === 'request') {
    if (!date || !time || !name || !phone || !email) {
      return res.status(400).json({ error: 'Champs manquants' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Date invalide' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    const phoneNorm = normalizePhone(phone);
    if (!/^(0|\+33)[0-9]{9}$/.test(phoneNorm) && !/^[0-9]{8,15}$/.test(phoneNorm)) {
      return res.status(400).json({ error: 'Numero de telephone invalide' });
    }

    const d = new Date(date + 'T12:00:00');
    if (d.getDay() === 0 || d.getDay() === 6) {
      return res.status(400).json({ error: 'Jour non disponible' });
    }

    const VALID_SLOTS = [
      '09:00','09:30','10:00','10:30','11:00','11:30',
      '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'
    ];
    if (!VALID_SLOTS.includes(time)) {
      return res.status(400).json({ error: 'Creneau invalide' });
    }

    try {
      // Vérifier si le slot est déjà définitivement réservé
      const booked = await sql`
        SELECT 1 FROM appointments WHERE date = ${date} AND time_slot = ${time} AND status = 'booked' LIMIT 1
      `;
      if (booked.rows.length > 0) {
        return res.status(409).json({ error: 'Ce creneau est deja pris, choisissez-en un autre.' });
      }

      // Vérifier si ce numéro a déjà un RDV actif
      const today = new Date().toISOString().split('T')[0];
      const existing = await sql`
        SELECT date, time_slot FROM appointments
        WHERE phone_norm = ${phoneNorm} AND status = 'booked' AND date >= ${today}
        ORDER BY date ASC LIMIT 1
      `;
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Vous avez deja un rendez-vous.', existing: existing.rows[0] });
      }

      // Anti-spam : bloquer si un code a déjà été envoyé il y a moins de 60s
      const recentPending = await sql`
        SELECT 1 FROM appointments
        WHERE phone_norm = ${phoneNorm} AND status = 'pending'
          AND code_expires_at > NOW() + INTERVAL '9 minutes'
        LIMIT 1
      `.catch(() => ({ rows: [] }));
      if (recentPending.rows.length > 0) {
        return res.status(429).json({ error: 'Veuillez patienter 60 secondes avant de renvoyer un code.' });
      }

      // Nettoyer les anciens pending pour ce slot ou ce numéro
      await sql`DELETE FROM appointments WHERE status = 'pending' AND (date = ${date} AND time_slot = ${time})`.catch(() => {});
      await sql`DELETE FROM appointments WHERE status = 'pending' AND phone_norm = ${phoneNorm}`.catch(() => {});

      // Générer le code et insérer le pending
      const verificationCode = generateCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await sql`
        INSERT INTO appointments (date, time_slot, name, phone, phone_norm, email, status, verification_code, code_expires_at)
        VALUES (${date}, ${time}, ${name.trim()}, ${phone.trim()}, ${phoneNorm}, ${email.trim()}, 'pending', ${verificationCode}, ${expiresAt})
      `;

      // Envoyer le code par email
      if (process.env.RESEND_API_KEY) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });
        try {
          const emailResult = await resend.emails.send({
            from: 'Relion <noreply@relionapp.fr>',
            to: email.trim(),
            subject: `Votre code de confirmation Relion : ${verificationCode}`,
            html: `
              <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                <h2 style="font-size:22px;margin-bottom:8px;">Confirmez votre rendez-vous</h2>
                <p>Bonjour ${name.trim()},</p>
                <p>Vous avez demandé un rendez-vous le <strong>${dateLabel} à ${time}</strong>.</p>
                <p>Votre code de confirmation :</p>
                <div style="background:#f5f7ff;padding:24px;border-radius:10px;margin:20px 0;text-align:center;">
                  <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a56e8;">${verificationCode}</span>
                </div>
                <p style="color:#888;font-size:13px;">Ce code expire dans 10 minutes.</p>
                <p>— L'équipe Relion</p>
              </div>
            `
          });
          console.log('[book/request] Email envoyé:', JSON.stringify(emailResult));
        } catch (emailErr) {
          console.error('[book/request] Erreur Resend:', emailErr.message);
        }
      } else {
        console.warn('[book/request] RESEND_API_KEY manquant');
      }

      return res.status(200).json({ success: true });

    } catch (err) {
      if (err.message && err.message.toLowerCase().includes('unique')) {
        return res.status(409).json({ error: 'Ce creneau est deja pris, choisissez-en un autre.' });
      }
      console.error('[book/request] Erreur:', err.message);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // ÉTAPE 2 : Vérification du code — confirmer le RDV
  // ══════════════════════════════════════════════════════════════════════
  if (step === 'verify') {
    if (!date || !time || !phone || !code) {
      return res.status(400).json({ error: 'Champs manquants' });
    }

    const phoneNorm = normalizePhone(phone);

    try {
      const result = await sql`
        UPDATE appointments
        SET status = 'booked', verification_code = NULL, code_expires_at = NULL
        WHERE date = ${date}
          AND time_slot = ${time}
          AND phone_norm = ${phoneNorm}
          AND status = 'pending'
          AND verification_code = ${code}
          AND code_expires_at > NOW()
        RETURNING name, phone, email, date, time_slot
      `;

      if (result.rowCount === 0) {
        return res.status(400).json({ error: 'Code invalide ou expiré. Recommencez.' });
      }

      const appt = result.rows[0];

      // Si modification : supprimer l'ancien créneau atomiquement
      const { cancelDate, cancelTime } = req.body || {};
      if (cancelDate && cancelTime) {
        await sql`
          DELETE FROM appointments
          WHERE date = ${cancelDate} AND time_slot = ${cancelTime} AND phone_norm = ${phoneNorm} AND status = 'booked'
        `.catch(() => {});
      }

      // Emails de confirmation
      if (process.env.RESEND_API_KEY) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const dateLabel = new Date(appt.date + 'T12:00:00').toLocaleDateString('fr-FR', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });

        if (appt.email) {
          resend.emails.send({
            from: 'Relion <noreply@relionapp.fr>',
            to: appt.email,
            subject: `Rendez-vous confirmé — ${dateLabel} à ${appt.time_slot}`,
            html: `
              <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
                <h2 style="font-size:22px;margin-bottom:8px;">Votre rendez-vous est confirmé ✓</h2>
                <p>Bonjour ${appt.name},</p>
                <p>Votre appel avec l'équipe Relion est planifié :</p>
                <div style="background:#f5f7ff;padding:16px;border-radius:10px;margin:20px 0;">
                  <p style="margin:4px 0;"><strong>📅 Date :</strong> ${dateLabel}</p>
                  <p style="margin:4px 0;"><strong>⏰ Heure :</strong> ${appt.time_slot}</p>
                  <p style="margin:4px 0;"><strong>📞 Numéro :</strong> ${appt.phone}</p>
                </div>
                <p>Nous vous appellerons à l'heure prévue. À bientôt !</p>
                <p>— L'équipe Relion</p>
              </div>
            `
          }).catch(() => {});
        }

        resend.emails.send({
          from: 'Relion <noreply@relionapp.fr>',
          to: 'alix.sarikabadayi@gmail.com',
          subject: `📅 Nouveau RDV — ${appt.name} le ${dateLabel} à ${appt.time_slot}`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
              <h2>Nouveau rendez-vous 📞</h2>
              <p><strong>Nom :</strong> ${appt.name}</p>
              <p><strong>Téléphone :</strong> ${appt.phone}</p>
              <p><strong>Email :</strong> ${appt.email || 'non renseigné'}</p>
              <p><strong>Date :</strong> ${dateLabel} à ${appt.time_slot}</p>
            </div>
          `
        }).catch(() => {});
      }

      return res.status(200).json({ success: true });

    } catch (err) {
      console.error('[book/verify] Erreur:', err.message);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // ÉTAPE : Demande de code pour annulation/modification
  // ══════════════════════════════════════════════════════════════════════
  if (step === 'request-cancel') {
    if (!date || !time || !phone) return res.status(400).json({ error: 'Champs manquants' });
    const phoneNorm = normalizePhone(phone);
    try {
      const appt = await sql`
        SELECT * FROM appointments
        WHERE date = ${date} AND time_slot = ${time} AND phone_norm = ${phoneNorm} AND status = 'booked'
        LIMIT 1
      `;
      if (appt.rows.length === 0) return res.status(404).json({ error: 'Rendez-vous introuvable' });
      const booking = appt.rows[0];
      const verificationCode = generateCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await sql`
        UPDATE appointments SET verification_code = ${verificationCode}, code_expires_at = ${expiresAt}
        WHERE date = ${date} AND time_slot = ${time} AND phone_norm = ${phoneNorm} AND status = 'booked'
      `;
      if (process.env.RESEND_API_KEY && booking.email) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
        resend.emails.send({
          from: 'Relion <noreply@relionapp.fr>',
          to: booking.email,
          subject: `Code de confirmation — modification de votre RDV Relion`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
              <h2>Confirmer la modification</h2>
              <p>Vous souhaitez modifier ou annuler votre rendez-vous du <strong>${dateLabel} à ${time}</strong>.</p>
              <p>Votre code de confirmation :</p>
              <div style="background:#f5f7ff;padding:24px;border-radius:10px;margin:20px 0;text-align:center;">
                <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a56e8;">${verificationCode}</span>
              </div>
              <p style="color:#888;font-size:13px;">Ce code expire dans 10 minutes.</p>
              <p>— L'équipe Relion</p>
            </div>
          `
        }).catch(() => {});
      }
      return res.status(200).json({ success: true, email: booking.email || '' });
    } catch (err) {
      console.error('[book/request-cancel] Erreur:', err.message);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // ÉTAPE : Vérification du code pour annulation/modification
  // ══════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  // ÉTAPE : Vérifier le code pour modification (sans supprimer l'ancien créneau)
  // ══════════════════════════════════════════════════════════════════════
  if (step === 'verify-modify') {
    if (!date || !time || !phone || !code) return res.status(400).json({ error: 'Champs manquants' });
    const phoneNorm = normalizePhone(phone);
    try {
      const result = await sql`
        SELECT 1 FROM appointments
        WHERE date = ${date} AND time_slot = ${time} AND phone_norm = ${phoneNorm}
          AND status = 'booked' AND verification_code = ${code} AND code_expires_at > NOW()
      `;
      if (result.rows.length === 0) return res.status(400).json({ error: 'Code invalide ou expiré. Recommencez.' });
      // Invalider le code après vérification
      await sql`
        UPDATE appointments SET verification_code = NULL, code_expires_at = NULL
        WHERE date = ${date} AND time_slot = ${time} AND phone_norm = ${phoneNorm} AND status = 'booked'
      `.catch(() => {});
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[book/verify-modify] Erreur:', err.message);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  if (step === 'verify-cancel') {
    if (!date || !time || !phone || !code) return res.status(400).json({ error: 'Champs manquants' });
    const phoneNorm = normalizePhone(phone);
    try {
      const result = await sql`
        DELETE FROM appointments
        WHERE date = ${date} AND time_slot = ${time} AND phone_norm = ${phoneNorm}
          AND status = 'booked' AND verification_code = ${code} AND code_expires_at > NOW()
        RETURNING id
      `;
      if (result.rowCount === 0) return res.status(400).json({ error: 'Code invalide ou expiré. Recommencez.' });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[book/verify-cancel] Erreur:', err.message);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  return res.status(400).json({ error: 'Etape inconnue' });
};
