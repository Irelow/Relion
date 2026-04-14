const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Methode non autorisee' });

  const { email, message } = req.body || {};

  if (!email || !message) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Service email non configure' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Relion Contact <onboarding@resend.dev>',
      to: 'alix.sarikabadayi@gmail.com',
      reply_to: email,
      subject: `Message de ${email} via Relion`,
      html: `<h2>Nouveau message via Relion</h2><p><strong>De :</strong> ${email}</p><p>${message.replace(/\n/g, '<br>')}</p>`
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[send-contact] Erreur Resend :', err.message);
    return res.status(500).json({ error: "Erreur lors de l'envoi de l'email" });
  }
};
