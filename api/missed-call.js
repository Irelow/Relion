/**
 * POST /api/missed-call   ← Webhook Twilio (appel manqué)
 *
 * COMMENT ÇA MARCHE :
 *  1. L'artisan obtient un numéro Twilio virtuel (ex. +33757XXXXXX) → ~1€/mois
 *  2. Il redirige ses appels professionnels vers ce numéro Twilio
 *     (sur iPhone/Android : réglages opérateur, ou via l'app Twilio)
 *  3. Twilio essaie de faire sonner le vrai mobile de l'artisan (ARTISAN_PHONE)
 *  4. Si l'artisan ne décroche pas → Twilio appelle CE webhook
 *  5. Ce webhook renvoie un TwiML "ne pas décrocher" + envoie le SMS au prospect
 *
 * Variables d'environnement :
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER  – numéro Twilio expéditeur
 *   ARTISAN_PHONE        – vrai numéro mobile de l'artisan (pour le transfert d'appel)
 *   SMS_TEMPLATE         – texte du SMS (optionnel, sinon texte par défaut)
 *   RECALL_URL           – lien de rappel/formulaire à inclure dans le SMS
 *   WEBHOOK_SECRET       – token secret pour vérifier que c'est bien Twilio qui appelle
 */

const twilio = require('twilio');
const { twiml: { VoiceResponse } } = twilio;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).end();

  // Vérification signature Twilio (sécurité)
  const twilioSignature = req.headers['x-twilio-signature'];
  const webhookUrl      = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/missed-call`
    : process.env.WEBHOOK_URL;

  if (webhookUrl && process.env.TWILIO_AUTH_TOKEN) {
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      webhookUrl,
      req.body
    );
    if (!isValid) {
      console.warn('[missed-call] Signature invalide — requête rejetée');
      return res.status(403).end();
    }
  }

  const callerNumber = req.body.From;   // numéro qui a appelé
  const artisanName  = process.env.ARTISAN_NAME || 'votre artisan';
  const recallUrl    = process.env.RECALL_URL   || 'relion.fr/rappel';

  const smsBody = process.env.SMS_TEMPLATE
    ? process.env.SMS_TEMPLATE
        .replace('{nom}', artisanName)
        .replace('{url}', recallUrl)
    : `Bonjour, j'ai bien reçu votre appel.\n\nJe suis actuellement en intervention.\nVous pouvez remplir ce formulaire :\n${recallUrl}\n\nJe vous rappelle ensuite. — ${artisanName}`;

  try {
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    // Envoi du SMS au prospect
    await client.messages.create({
      body: smsBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   callerNumber
    });

    console.log(`[missed-call] SMS envoyé à ${callerNumber}`);

    // Optionnel : notifier aussi l'artisan
    if (process.env.ARTISAN_PHONE) {
      await client.messages.create({
        body: `📞 Appel manqué de ${callerNumber} — SMS de réponse envoyé automatiquement. Relion.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   process.env.ARTISAN_PHONE
      });
    }

  } catch (err) {
    console.error('[missed-call] Erreur SMS :', err.message);
    // On continue quand même pour répondre correctement à Twilio
  }

  // Réponse TwiML à Twilio : raccrocher proprement
  const twimlResponse = new VoiceResponse();
  twimlResponse.hangup();

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twimlResponse.toString());
};
