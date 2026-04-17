/**
 * POST /api/contact
 * Reçoit le formulaire "Être rappelé" et :
 *  1. Envoie un SMS au propriétaire Relion (vous) pour notifier le nouveau lead
 *  2. Envoie un SMS de confirmation au prospect (optionnel)
 *
 * Variables d'environnement nécessaires (à configurer dans Vercel Dashboard) :
 *   TWILIO_ACCOUNT_SID   – SID de votre compte Twilio
 *   TWILIO_AUTH_TOKEN    – Token d'auth Twilio
 *   TWILIO_PHONE_NUMBER  – Votre numéro Twilio expéditeur (ex. +33757XXXXXX)
 *   OWNER_PHONE_NUMBER   – Votre numéro personnel pour recevoir les alertes leads
 */

const twilio = require('twilio');

module.exports = async function handler(req, res) {
  // CORS – permet d'appeler depuis le site même s'il est servi ailleurs
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Méthode non autorisée' });

  const { prenom, telephone, activite } = req.body || {};

  // Validation basique côté serveur
  if (!prenom || !telephone || !activite) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  // Nettoyage du numéro (supprime espaces/tirets, ajoute +33 si besoin)
  const telClean = normalizePhone(telephone);

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    // 1. Alerte lead → vous (propriétaire)
    await client.messages.create({
      body: [
        '🔔 Nouveau lead Relion !',
        `Prénom : ${prenom}`,
        `Tél    : ${telClean}`,
        `Activité : ${activite}`,
        `Reçu le ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`
      ].join('\n'),
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   process.env.OWNER_PHONE_NUMBER
    });

    // 2. Confirmation au prospect (optionnel — commentez si non souhaité)
    if (telClean) {
      await client.messages.create({
        body: `Bonjour ${prenom}, merci pour votre intérêt pour Relion !\nNous vous rappelons sous 24h pour configurer votre SMS automatique. — L'équipe Relion`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   telClean
      });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[contact] Erreur Twilio :', err.message);
    return res.status(500).json({ error: 'Erreur lors de l\'envoi du SMS' });
  }
};

/**
 * Normalise un numéro FR vers le format E.164 (+33XXXXXXXXX)
 * Exemples : "06 12 34 56 78" → "+33612345678"
 *            "+33612345678"   → "+33612345678"
 */
function normalizePhone(raw) {
  const digits = raw.replace(/[\s\-\.]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return '+' + digits.slice(2);
  if (digits.startsWith('0'))  return '+33' + digits.slice(1);
  return '+33' + digits;
}
