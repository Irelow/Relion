const { sql } = require('@vercel/postgres');
const { Resend } = require('resend');

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  let p = (raw || '').trim().replace(/[\s\-\.]/g, '');
  if (p.startsWith('+33')) p = '0' + p.slice(3);
  if (p.startsWith('0033')) p = '0' + p.slice(4);
  return p;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

function normalizeDate(raw) {
  return (raw || '').split('T')[0];
}

const VALID_SLOTS = [
  '09:00','09:30','10:00','10:30','11:00','11:30',
  '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'
];

async function runMigrations() {
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS phone_norm VARCHAR(20)`.catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_appointments_phone_norm ON appointments(phone_norm)`.catch(() => {});
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS verification_code VARCHAR(64)`.catch(() => {});
  await sql`ALTER TABLE appointments ALTER COLUMN verification_code TYPE VARCHAR(64)`.catch(() => {});
  await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS code_expires_at TIMESTAMPTZ`.catch(() => {});
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    await resend.emails.send({ from: 'Relion <noreply@relionapp.fr>', to, subject, html });
  } catch (e) {
    console.error('[sendEmail] Erreur:', e.message);
  }
}

async function sendConfirmationEmails(appt) {
  const dateLabel = new Date(appt.date + 'T12:00:00').toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  if (appt.email) {
    sendEmail(appt.email, `Rendez-vous confirmé — ${dateLabel} à ${appt.time_slot}`,
      `<div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <h2>Votre rendez-vous est confirmé ✓</h2>
        <p>Bonjour ${appt.name},</p>
        <div style="background:#f5f7ff;padding:16px;border-radius:10px;margin:20px 0;">
          <p style="margin:4px 0;"><strong>📅 Date :</strong> ${dateLabel}</p>
          <p style="margin:4px 0;"><strong>⏰ Heure :</strong> ${appt.time_slot}</p>
          <p style="margin:4px 0;"><strong>📞 Numéro :</strong> ${appt.phone}</p>
        </div>
        <p>Nous vous appellerons à l'heure prévue. À bientôt !</p>
        <p>— L'équipe Relion</p>
      </div>`
    );
  }

  sendEmail('alix.sarikabadayi@gmail.com',
    `📅 Nouveau RDV — ${appt.name} le ${dateLabel} à ${appt.time_slot}`,
    `<div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
      <h2>Nouveau rendez-vous 📞</h2>
      <p><strong>Nom :</strong> ${appt.name}</p>
      <p><strong>Téléphone :</strong> ${appt.phone}</p>
      <p><strong>Email :</strong> ${appt.email || 'non renseigné'}</p>
      <p><strong>Date :</strong> ${dateLabel} à ${appt.time_slot}</p>
    </div>`
  );
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  await runMigrations();

  const body = req.body || {};

  switch (body.step) {
    case 'request':        return handleRequest(body, res);
    case 'verify':         return handleVerify(body, res);
    case 'request-cancel': return handleRequestCancel(body, res);
    case 'verify-cancel':  return handleVerifyCancel(body, res);
    case 'verify-modify':  return handleVerifyModify(body, res);
    case 'swap':           return handleSwap(body, res);
    default:               return res.status(400).json({ error: 'Etape inconnue' });
  }
};

// ─── 1. Request booking code ──────────────────────────────────────────────────

async function handleRequest(body, res) {
  const { date, time, name, phone, email } = body;

  if (!date || !time || !name || !phone || !email)
    return res.status(400).json({ error: 'Champs manquants' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Date invalide' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return res.status(400).json({ error: 'Email invalide' });

  const phoneNorm = normalizePhone(phone);
  if (!/^(0|\+33)[0-9]{9}$/.test(phoneNorm) && !/^[0-9]{8,15}$/.test(phoneNorm))
    return res.status(400).json({ error: 'Numero de telephone invalide' });

  const d = new Date(date + 'T12:00:00');
  if (d.getDay() === 0 || d.getDay() === 6)
    return res.status(400).json({ error: 'Jour non disponible' });
  if (!VALID_SLOTS.includes(time))
    return res.status(400).json({ error: 'Creneau invalide' });

  try {
    // Anti-spam: block if a code was sent less than 60s ago
    const recent = await sql`
      SELECT 1 FROM appointments
      WHERE phone_norm = ${phoneNorm} AND status = 'pending'
        AND code_expires_at > NOW() + INTERVAL '9 minutes'
      LIMIT 1
    `.catch(() => ({ rows: [] }));
    if (recent.rows.length > 0)
      return res.status(429).json({ error: 'Patientez 60 secondes avant de renvoyer un code.' });

    // Check slot not already booked
    const slotTaken = await sql`
      SELECT 1 FROM appointments WHERE date = ${date} AND time_slot = ${time} AND status = 'booked' LIMIT 1
    `;
    if (slotTaken.rows.length > 0)
      return res.status(409).json({ error: 'Ce creneau est deja pris.' });

    // Check phone has no active booking
    const today = new Date().toISOString().split('T')[0];
    const existing = await sql`
      SELECT date, time_slot FROM appointments
      WHERE phone_norm = ${phoneNorm} AND status = 'booked' AND date >= ${today}
      ORDER BY date ASC LIMIT 1
    `;
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Vous avez deja un rendez-vous.', existing: existing.rows[0] });

    // Clean up old pending for same slot or same phone
    await sql`DELETE FROM appointments WHERE status = 'pending' AND date = ${date} AND time_slot = ${time}`.catch(() => {});
    await sql`DELETE FROM appointments WHERE status = 'pending' AND phone_norm = ${phoneNorm}`.catch(() => {});

    // Insert pending with code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO appointments (date, time_slot, name, phone, phone_norm, email, status, verification_code, code_expires_at)
      VALUES (${date}, ${time}, ${name.trim()}, ${phone.trim()}, ${phoneNorm}, ${email.trim()}, 'pending', ${code}, ${expiresAt})
    `;

    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    await sendEmail(email.trim(), `Code de confirmation Relion : ${code}`,
      `<div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <h2>Confirmez votre rendez-vous</h2>
        <p>Bonjour ${name.trim()},</p>
        <p>Rendez-vous demandé : <strong>${dateLabel} à ${time}</strong></p>
        <div style="background:#f5f7ff;padding:24px;border-radius:10px;margin:20px 0;text-align:center;">
          <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a56e8;">${code}</span>
        </div>
        <p style="color:#888;font-size:13px;">Ce code expire dans 10 minutes.</p>
        <p>— L'équipe Relion</p>
      </div>`
    );

    return res.status(200).json({ success: true });

  } catch (err) {
    if (err.message?.toLowerCase().includes('unique'))
      return res.status(409).json({ error: 'Ce creneau est deja pris.' });
    console.error('[request]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ─── 2. Verify booking code ───────────────────────────────────────────────────

async function handleVerify(body, res) {
  const { date, time, phone, code } = body;
  if (!date || !time || !phone || !code)
    return res.status(400).json({ error: 'Champs manquants' });

  const phoneNorm = normalizePhone(phone);

  try {
    const result = await sql`
      UPDATE appointments
      SET status = 'booked', verification_code = NULL, code_expires_at = NULL
      WHERE date = ${date} AND time_slot = ${time} AND phone_norm = ${phoneNorm}
        AND status = 'pending' AND verification_code = ${code} AND code_expires_at > NOW()
      RETURNING name, phone, email, date, time_slot
    `;
    if (result.rowCount === 0)
      return res.status(400).json({ error: 'Code invalide ou expiré. Recommencez.' });

    sendConfirmationEmails(result.rows[0]);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[verify]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ─── 3. Request cancel/modify code ───────────────────────────────────────────

async function handleRequestCancel(body, res) {
  const { date, time, phone } = body;
  if (!date || !time || !phone)
    return res.status(400).json({ error: 'Champs manquants' });

  const phoneNorm = normalizePhone(phone);
  const dateStr = normalizeDate(date);

  try {
    const appt = await sql`
      SELECT * FROM appointments
      WHERE date = ${dateStr} AND time_slot = ${time} AND phone_norm = ${phoneNorm} AND status = 'booked'
      LIMIT 1
    `;
    if (appt.rows.length === 0)
      return res.status(404).json({ error: 'Rendez-vous introuvable' });

    const booking = appt.rows[0];
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await sql`
      UPDATE appointments SET verification_code = ${code}, code_expires_at = ${expiresAt}
      WHERE date = ${dateStr} AND time_slot = ${time} AND phone_norm = ${phoneNorm} AND status = 'booked'
    `;

    const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    await sendEmail(booking.email, `Code de confirmation — votre RDV Relion`,
      `<div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
        <h2>Confirmer l'action</h2>
        <p>Code pour votre rendez-vous du <strong>${dateLabel} à ${time}</strong> :</p>
        <div style="background:#f5f7ff;padding:24px;border-radius:10px;margin:20px 0;text-align:center;">
          <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#1a56e8;">${code}</span>
        </div>
        <p style="color:#888;font-size:13px;">Ce code expire dans 10 minutes.</p>
        <p>— L'équipe Relion</p>
      </div>`
    );

    return res.status(200).json({ success: true, email: booking.email || '' });
  } catch (err) {
    console.error('[request-cancel]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ─── 4a. Verify cancel code → delete slot ────────────────────────────────────

async function handleVerifyCancel(body, res) {
  const { date, time, phone, code } = body;
  if (!date || !time || !phone || !code)
    return res.status(400).json({ error: 'Champs manquants' });

  const phoneNorm = normalizePhone(phone);
  const dateStr = normalizeDate(date);

  try {
    const result = await sql`
      DELETE FROM appointments
      WHERE date = ${dateStr} AND time_slot = ${time} AND phone_norm = ${phoneNorm}
        AND status = 'booked' AND verification_code = ${code} AND code_expires_at > NOW()
      RETURNING id
    `;
    if (result.rowCount === 0)
      return res.status(400).json({ error: 'Code invalide ou expiré. Recommencez.' });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[verify-cancel]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ─── 4b. Verify modify code → return swap token (slot kept) ──────────────────

async function handleVerifyModify(body, res) {
  const { date, time, phone, code } = body;
  if (!date || !time || !phone || !code)
    return res.status(400).json({ error: 'Champs manquants' });

  const phoneNorm = normalizePhone(phone);
  const dateStr = normalizeDate(date);

  try {
    const check = await sql`
      SELECT 1 FROM appointments
      WHERE date = ${dateStr} AND time_slot = ${time} AND phone_norm = ${phoneNorm}
        AND status = 'booked' AND verification_code = ${code} AND code_expires_at > NOW()
    `;
    if (check.rows.length === 0)
      return res.status(400).json({ error: 'Code invalide ou expiré. Recommencez.' });

    // Replace code with a swap token valid 15 min
    const swapToken = generateToken();
    const swapExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await sql`
      UPDATE appointments SET verification_code = ${swapToken}, code_expires_at = ${swapExpiry}
      WHERE date = ${dateStr} AND time_slot = ${time} AND phone_norm = ${phoneNorm} AND status = 'booked'
    `;

    return res.status(200).json({ success: true, swapToken });
  } catch (err) {
    console.error('[verify-modify]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ─── 5. Swap slots (atomic, no email code required) ──────────────────────────

async function handleSwap(body, res) {
  const { date, time, name, phone, email, fromDate, fromTime, swapToken } = body;
  if (!date || !time || !name || !phone || !fromDate || !fromTime || !swapToken)
    return res.status(400).json({ error: 'Champs manquants' });

  const phoneNorm = normalizePhone(phone);
  const fromDateStr = normalizeDate(fromDate);

  try {
    // Verify swap token
    const tokenCheck = await sql`
      SELECT email FROM appointments
      WHERE date = ${fromDateStr} AND time_slot = ${fromTime} AND phone_norm = ${phoneNorm}
        AND status = 'booked' AND verification_code = ${swapToken} AND code_expires_at > NOW()
    `;
    if (tokenCheck.rows.length === 0)
      return res.status(401).json({ error: 'Session expirée. Recommencez depuis Modifier.' });

    // Validate new slot
    if (!VALID_SLOTS.includes(time))
      return res.status(400).json({ error: 'Creneau invalide' });
    const d = new Date(date + 'T12:00:00');
    if (d.getDay() === 0 || d.getDay() === 6)
      return res.status(400).json({ error: 'Jour non disponible' });

    // Check new slot is free
    const slotTaken = await sql`
      SELECT 1 FROM appointments WHERE date = ${date} AND time_slot = ${time} AND status = 'booked' LIMIT 1
    `;
    if (slotTaken.rows.length > 0)
      return res.status(409).json({ error: 'Ce creneau est deja pris. Choisissez-en un autre.' });

    // Atomic swap
    await sql`DELETE FROM appointments WHERE date = ${fromDateStr} AND time_slot = ${fromTime} AND phone_norm = ${phoneNorm}`;
    const apptEmail = (email || '').trim() || tokenCheck.rows[0].email || '';
    await sql`
      INSERT INTO appointments (date, time_slot, name, phone, phone_norm, email, status)
      VALUES (${date}, ${time}, ${name.trim()}, ${phone.trim()}, ${phoneNorm}, ${apptEmail}, 'booked')
    `;

    sendConfirmationEmails({ name: name.trim(), phone: phone.trim(), email: apptEmail, date, time_slot: time });
    return res.status(200).json({ success: true });

  } catch (err) {
    if (err.message?.toLowerCase().includes('unique'))
      return res.status(409).json({ error: 'Ce creneau est deja pris. Choisissez-en un autre.' });
    console.error('[swap]', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
