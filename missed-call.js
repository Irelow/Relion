/**
 * POST /api/missed-call   ← Webhook Twilio (appel manqué)
 *
 * COMMENT ÇA MARCHE :
 *  1. L'artisan obtient un numéro Twilio virtuel (relion_number)
 *  2. Twilio redirige les appels vers l'artisan ; si pas de réponse → ce webhook
 *  3. Ce webhook :
 *     a) retrouve l'artisan via son relion_number (table profiles)
 *     b) enregistre l'appel en base (table missed_calls)
 *     c) envoie le SMS au prospect
 *     d) notifie l'artisan
 *     e) répond à Twilio avec un TwiML "raccrocher"
 *
 * Variables d'environnement :
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   WEBHOOK_URL            – URL complète de ce webhook (pour validation signature)
 */

const twilio = require('twilio');
const { twiml: { VoiceResponse } } = twilio;
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).end();

  // ── Vérification signature Twilio ─────────────────────────────────────────
  const twilioSignature = req.headers['x-twilio-signature'];
  const webhookUrl = process.env.WEBHOOK_URL || ('https://' + process.env.VERCEL_URL + '/api/missed-call');

  if (webhookUrl && process.env.TWILIO_AUTH_TOKEN && twilioSignature) {
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      webhookUrl,
      req.body
    );
    if (!isValid) {
      console.warn('[missed-call] Signature Twilio invalide');
      return res.status(403).end();
    }
  }

  const callerNumber  = req.body.From || '';  // numéro du prospect qui a appelé
  const relionNumber  = req.body.To   || '';  // numéro Twilio de l'artisan

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // ── Trouver l'artisan via son numéro Relion ───────────────────────────────
  let profile = null;
  if (relionNumber) {
    const { data } = await supabase
      .from('profiles')
      .select('id, prenom, telephone, subscription_status')
      .eq('relion_number', relionNumber)
      .single();
    profile = data;
  }

  // ── Préparer le SMS ───────────────────────────────────────────────────────
  const artisanName = (profile?.prenom) || process.env.ARTISAN_NAME || 'votre artisan';
  const recallUrl   = process.env.RECALL_URL || 'relion.fr/rappel';

  const smsBody = process.env.SMS_TEMPLATE
    ? process.env.SMS_TEMPLATE.replace('{nom}', artisanName).replace('{url}', recallUrl)
    : 'Bonjour, j\'ai bien reçu votre appel.\n\nJe suis actuellement en intervention.\nVous pouvez remplir ce formulaire :\n' + recallUrl + '\n\nJe vous rappelle ensuite. — ' + artisanName;

  // ── Enregistrer l'appel en base ───────────────────────────────────────────
  let callId = null;
  if (profile) {
    const { data: callData } = await supabase
      .from('missed_calls')
      .insert({
        user_id:       profile.id,
        caller_number: callerNumber,
        called_at:     new Date().toISOString(),
        sms_content:   smsBody,
        status:        'nouveau'
      })
      .select('id')
      .single();

    callId = callData?.id;
    console.log('[missed-call] Appel enregistré en base, id:', callId);
  } else {
    console.warn('[missed-call] Artisan introuvable pour le numéro:', relionNumber);
  }

  // ── Envoyer les SMS ───────────────────────────────────────────────────────
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = relionNumber || process.env.TWILIO_PHONE_NUMBER;

  if (sid && token && callerNumber && from) {
    try {
      const client = twilio(sid, token);

      // SMS au prospect
      await client.messages.create({ body: smsBody, from, to: callerNumber });
      console.log('[missed-call] SMS envoyé au prospect', callerNumber);

      // Marquer le SMS comme envoyé en base
      if (callId) {
        await supabase
          .from('missed_calls')
          .update({ sms_sent: true })
          .eq('id', callId);
      }

      // Notification à l'artisan
      const artisanPhone = profile?.telephone || process.env.ARTISAN_PHONE;
      if (artisanPhone) {
        await client.messages.create({
          body: '📞 Appel manqué de ' + callerNumber + '\nSMS de réponse envoyé automatiquement. — Relion',
          from,
          to: artisanPhone
        });
      }

    } catch (err) {
      console.error('[missed-call] Erreur SMS :', err.message);
    }
  } else {
    console.log('[missed-call] SMS non envoyé — Twilio non configuré ou numéro manquant');
  }

  // ── Répondre à Twilio : raccrocher proprement ─────────────────────────────
  const twimlResponse = new VoiceResponse();
  twimlResponse.hangup();

  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twimlResponse.toString());
};
