// Crea (o actualiza) el TwiML App de Twilio Voice que apunta al webhook de llamadas.
// Uso: node scripts/setup-twiml-app.js
// Requiere en el entorno: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, BACKEND_PUBLIC_URL
require("dotenv").config();

async function main() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, BACKEND_PUBLIC_URL } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !BACKEND_PUBLIC_URL) {
    console.error("Faltan TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o BACKEND_PUBLIC_URL en el entorno");
    process.exit(1);
  }

  const client = require("twilio")(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const voiceUrl = `${BACKEND_PUBLIC_URL}/api/voice/twiml`;

  const app = await client.applications.create({
    friendlyName: "Sales CRM Voice App",
    voiceUrl,
    voiceMethod: "POST",
  });

  console.log("TwiML App creado.");
  console.log("Copia esto a tus variables de entorno:");
  console.log(`TWILIO_TWIML_APP_SID=${app.sid}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
