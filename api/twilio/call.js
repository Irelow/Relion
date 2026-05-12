const { sql } = require('@vercel/postgres');
const twilio = require('twilio');

const ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER  = process.env.TWILIO_PHONE_NUMBER;
const ARTISAN_PHONE  = process.env.ARTISAN_PHONE;

async function runMigrations() {
  await sql`
    CREATE TABLE IF NOT EXISTS missed_calls (
      id          SERIAL PRIMARY KEY,
      caller      VARCHAR(30) NOT NULL,
      called_at   TIMESTAMP DEFAULT NOW(),
      sms_sent    BOOLEAN DEFAULT FALSE,
      sms_message TEXT
    )
  `.catch(() => {});
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const body = req.body || {};
  const { DialCallStatus, From } = body;

  if (DialCallStatus) {
    if (['no-answer', 'busy', 'failed', 'canceled'].includes(DialCallStatus)) {
      try {
        await runMigrations();

        const userRow = await sql`SELECT sms_message FROM users LIMIT 1`;
        const smsMessage = userRow.rows[0]?.sms_message ||
          "Bonjour, je n'ai pas pu répondre à votre appel. Je vous rappelle dès que possible. — Relion";

        const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
        await client.messages.create({
          body: smsMessage,
          from: TWILIO_NUMBER,
          to:   From
        });

        await sql`
          INSERT INTO missed_calls (caller, sms_sent, sms_message)
          VALUES (${From}, true, ${smsMessage})
        `.catch(() => {});

      } catch (err) {
        console.error('[twilio/call] Erreur envoi SMS :', err);
      }
    }

    return res.send('<Response></Response>');
  }

  const callbackUrl = `https://relion-five.vercel.app/api/twilio/call`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" action="${callbackUrl}" method="POST">
    <Number>${ARTISAN_PHONE}</Number>
  </Dial>
</Response>`;

  return res.send(twiml);
};