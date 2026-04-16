const { sql } = require('@vercel/postgres');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const { email: rawEmail } = req.body || {};
  const email = (rawEmail || '').trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }

  try {
    const result = await sql`
      SELECT prenom, nom, telephone, password_hash, resend_count, last_resend_at, expires_at
      FROM pending_registrations
      WHERE email = ${email}
      LIMIT 1
    `;

    // Email inconnu → réponse volontairement vague (sécurité : pas de fuite d'info)
    if (result.rows.length === 0) {
      return res.status(200).json({ message: "Si votre inscription est en attente, un email a été envoyé." });
    }

    const p   = result.rows[0];
    const now = new Date();

    // Lien expiré → supprimer et inviter à se réinscrire
    if (now > new Date(p.expires_at)) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return res.status(410).json({ error: 'Votre lien a expiré. Veuillez vous réinscrire depuis le formulaire.' });
    }

    // Limite de renvois atteinte
    if (p.resend_count >= 3) {
      return res.status(429).json({ error: 'Nombre maximum de renvois atteint (3/3). Réessayez demain ou contactez-nous.' });
    }

    // Cooldown 5 minutes entre chaque renvoi
    const minsSince = (now - new Date(p.last_resend_at)) / 60000;
    if (minsSince < 5) {
      const wait = Math.ceil(5 - minsSince);
      return res.status(429).json({
        error:       `Attendez encore ${wait} minute(s) avant de renvoyer.`,
        waitMinutes: wait
      });
    }

    // Générer un nouveau token (invalide les anciens liens)
    const verifyToken = jwt.sign(
      {
        prenom: p.prenom, nom: p.nom, email, telephone: p.telephone,
        passwordHash: p.password_hash, purpose: 'email_verification'
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Mettre à jour le compteur + timestamp + prolonger l'expiration
    await sql`
      UPDATE pending_registrations
      SET resend_count   = resend_count + 1,
          last_resend_at = NOW(),
          expires_at     = NOW() + INTERVAL '24 hours'
      WHERE email = ${email}
    `;

    // Envoyer le nouvel email
    const resendClient = new Resend(process.env.RESEND_API_KEY);
    const verifyUrl    = `https://relion-five.vercel.app/api/auth/verify?token=${verifyToken}`;
    const sendCount    = p.resend_count + 1;

    await resendClient.emails.send({
      from:    'Relion <noreply@relionapp.fr>',
      to:      email,
      subject: `Nouveau lien de confirmation — Relion (${sendCount}/3)`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#fff;">
          <h1 style="font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:8px;">
            Voici votre nouveau lien 🔗
          </h1>
          <p style="color:#555;font-size:15px;margin-bottom:28px;line-height:1.6;">
            Bonjour ${p.prenom}, cliquez ci-dessous pour confirmer votre adresse email.
          </p>
          <a href="${verifyUrl}"
            style="display:inline-block;padding:14px 28px;background:#1A56E8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
            Confirmer mon email →
          </a>
          <p style="color:#aaa;font-size:12px;margin-top:28px;line-height:1.5;">
            Ce lien expire dans 24 heures · Renvoi ${sendCount}/3<br/>
            Si vous n'avez pas créé de compte Relion, ignorez cet email.
          </p>
        </div>
      `
    });

    return res.status(200).json({ message: 'Email renvoyé avec succès.', resendsLeft: 3 - sendCount });

  } catch (err) {
    console.error('[resend] Erreur:', err);
    return res.status(500).json({ error: 'Erreur serveur — réessayez dans quelques instants.' });
  }
};
