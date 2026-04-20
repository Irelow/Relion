const { sql } = require('@vercel/postgres');
const jwt = require('jsonwebtoken');

const SITE = 'https://relionapp.fr';

module.exports = async function handler(req, res) {
  const { token } = req.query;

  // Token manquant
  if (!token) {
    return res.redirect(`${SITE}?verified=error&msg=lien_invalide`);
  }

  try {
    // Migration : ajouter colonne nom si manquante
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS nom VARCHAR(100) DEFAULT ''`.catch(() => {});

    // Décoder et vérifier la signature + expiration
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Vérifier que c'est bien un token de vérification d'email
    if (payload.purpose !== 'email_verification') {
      return res.redirect(`${SITE}?verified=error&msg=lien_invalide`);
    }

    const { prenom, nom, email, telephone, passwordHash } = payload;

    // Compte déjà créé ? (double-clic sur le lien, ou lien rouvert plus tard)
    const alreadyExists = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    if (alreadyExists.rows.length > 0) {
      // Compte déjà actif → rediriger vers connexion sans erreur
      return res.redirect(`${SITE}?verified=already`);
    }

    // Numéro de téléphone pris par quelqu'un d'autre entre temps ?
    const phoneConflict = await sql`SELECT id FROM users WHERE telephone = ${telephone} LIMIT 1`;
    if (phoneConflict.rows.length > 0) {
      return res.redirect(`${SITE}?verified=error&msg=telephone_pris`);
    }

    // Créer le compte dans users
    const result = await sql`
      INSERT INTO users (prenom, nom, email, telephone, password_hash, subscription_status, created_at)
      VALUES (${prenom}, ${nom || ''}, ${email}, ${telephone}, ${passwordHash}, 'trial', NOW())
      RETURNING id, prenom, nom, email, telephone, sms_message, subscription_status
    `;
    const user = result.rows[0];

    // Supprimer de pending_registrations
    await sql`DELETE FROM pending_registrations WHERE email = ${email}`.catch(() => {});

    // Générer un JWT de connexion (7j)
    const loginToken = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Rediriger vers le site avec le token → connexion automatique
    return res.redirect(`${SITE}?verified=success&token=${loginToken}`);

  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.redirect(`${SITE}?verified=error&msg=lien_expire`);
    }
    if (err.name === 'JsonWebTokenError') {
      return res.redirect(`${SITE}?verified=error&msg=lien_invalide`);
    }
    console.error('[verify] Erreur:', err);
    return res.redirect(`${SITE}?verified=error&msg=erreur_serveur`);
  }
};
