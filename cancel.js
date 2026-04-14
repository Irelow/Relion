/**
 * POST /api/cancel
 * Résilie l'abonnement Stripe de l'utilisateur connecté.
 *
 * Headers attendus :
 *   Authorization: Bearer <supabase_access_token>
 *
 * Body JSON :
 *   { reason: "raison de résiliation" }
 *
 * Variables d'environnement :
 *   STRIPE_SECRET_KEY      – Clé secrète Stripe
 *   SUPABASE_URL           – URL du projet Supabase
 *   SUPABASE_SERVICE_KEY   – Clé service_role Supabase
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // 1. Auth Supabase
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Token manquant' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }

  const userId = userData.user.id;
  const { reason } = req.body || {};

  // 2. Récupérer l'abonnement Stripe depuis le profil
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('stripe_subscription_id, prenom')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: 'Profil introuvable' });
  }

  const subscriptionId = profile.stripe_subscription_id;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'Aucun abonnement actif trouvé' });
  }

  // 3. Résilier immédiatement via Stripe
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (stripeErr) {
    console.error('[cancel] Erreur Stripe :', stripeErr.message);
    return res.status(500).json({ error: 'Erreur Stripe : ' + stripeErr.message });
  }

  // 4. Mettre à jour le profil en base
  await supabase
    .from('profiles')
    .update({
      subscription_status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason || ''
    })
    .eq('id', userId);

  console.log('[cancel] Résiliation de ' + (profile.prenom || userId) + ' — raison : ' + (reason || '(non renseignée)'));

  return res.status(200).json({ success: true });
};
