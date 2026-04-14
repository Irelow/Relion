/**
 * POST /api/stripe-webhook
 * Reçoit les événements Stripe et met à jour Supabase.
 *
 * Variables d'environnement :
 *   STRIPE_SECRET_KEY      – Clé secrète Stripe
 *   STRIPE_WEBHOOK_SECRET  – Signing secret (whsec_...)
 *   SUPABASE_URL           – URL du projet Supabase
 *   SUPABASE_SERVICE_KEY   – Clé service_role Supabase
 *   TWILIO_ACCOUNT_SID     – SID Twilio (optionnel)
 *   TWILIO_AUTH_TOKEN      – Token Twilio (optionnel)
 *   TWILIO_PHONE_NUMBER    – Numéro Twilio expéditeur (optionnel)
 *   OWNER_PHONE_NUMBER     – Numéro du propriétaire pour alertes (optionnel)
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

/* Vercel : désactiver le body parser pour lire le raw body (requis par Stripe) */
module.exports.config = { api: { bodyParser: false } };

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

async function sendSMS(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !from) {
    console.log('[webhook] SMS ignoré (Twilio non configuré) — message :', body.substring(0, 80));
    return;
  }
  if (!to) {
    console.log('[webhook] SMS ignoré (numéro destinataire manquant)');
    return;
  }

  const twilio = require('twilio');
  try {
    await twilio(sid, token).messages.create({ body, from, to });
    console.log('[webhook] SMS envoyé à', to);
  } catch (err) {
    console.error('[webhook] Erreur SMS :', err.message);
  }
}

function readRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end',  function()      { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/* ── Handler principal ────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] Signature invalide :', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  const supabase = getSupabase();

  /* ── checkout.session.completed ── */
  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object;
    const meta      = session.metadata || {};
    const email     = session.customer_email || '';
    const prenom    = meta.prenom    || '';
    const telephone = meta.telephone || '';
    const activite  = meta.activite  || '';
    const plan      = meta.plan      || 'Relion';

    console.log('[webhook] Nouvel abonné :', prenom, email, telephone);

    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const supabaseUser = (authUsers?.users || []).find(u => u.email === email);

    if (supabaseUser) {
      const trialEndsAt = new Date();
      trialEndsAt.setDate(trialEndsAt.getDate() + 30);

      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert({
          id:                     supabaseUser.id,
          prenom:                 prenom,
          telephone:              telephone,
          activite:               activite,
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          subscription_status:    'trial',
          trial_ends_at:          trialEndsAt.toISOString()
        }, { onConflict: 'id' });

      if (upsertError) console.error('[webhook] Erreur upsert profil :', upsertError.message);
      else console.log('[webhook] Profil Supabase mis à jour pour', email);
    } else {
      console.warn('[webhook] Utilisateur Supabase introuvable :', email);
    }

    await sendSMS(
      process.env.OWNER_PHONE_NUMBER,
      '🎉 Nouvel abonné Relion !\nPrénom : ' + prenom + '\nTél : ' + telephone + '\nActivité : ' + activite
    );

    await sendSMS(
      telephone,
      'Bonjour ' + prenom + ' ! Bienvenue sur Relion 🎉\nVotre essai gratuit de 30 jours démarre maintenant. Notre équipe vous contacte sous 48h pour configurer votre numéro. — Relion'
    );
  }

  /* ── customer.subscription.updated : fin essai → actif ── */
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const wasTrialing = event.data.previous_attributes?.status === 'trialing';
    const isNowActive = sub.status === 'active';

    if (wasTrialing && isNowActive) {
      console.log('[webhook] Fin essai → actif :', sub.customer);
      await supabase
        .from('profiles')
        .update({ subscription_status: 'active' })
        .eq('stripe_customer_id', sub.customer);
    }
  }

  /* ── customer.subscription.deleted : résiliation ── */
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    console.log('[webhook] Résiliation Stripe :', sub.customer);

    await supabase
      .from('profiles')
      .update({ subscription_status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('stripe_customer_id', sub.customer);

    await sendSMS(process.env.OWNER_PHONE_NUMBER, '⚠️ Résiliation Stripe\nClient : ' + sub.customer);
  }

  /* ── invoice.payment_failed : paiement échoué ── */
  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    console.log('[webhook] Paiement échoué :', invoice.customer);

    await supabase
      .from('profiles')
      .update({ subscription_status: 'past_due' })
      .eq('stripe_customer_id', invoice.customer);

    await sendSMS(
      process.env.OWNER_PHONE_NUMBER,
      '❌ Paiement échoué\nClient : ' + invoice.customer + '\nMontant : ' + (invoice.amount_due / 100).toFixed(2) + '€'
    );
  }

  /* ── invoice.payment_succeeded ── */
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    console.log('[webhook] Paiement réussi :', invoice.customer, (invoice.amount_paid / 100) + '€');
    await supabase
      .from('profiles')
      .update({ subscription_status: 'active' })
      .eq('stripe_customer_id', invoice.customer);
  }

  return res.status(200).json({ received: true });
};
