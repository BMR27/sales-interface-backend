const twilio = require("twilio");
const { normalizePhoneNumber } = require("./twilioVoice");

// Número distinto al de voz (TWILIO_CALLER_ID) -- ese no tiene SMS
// habilitado en la cuenta (confirmado contra la API de Twilio). Mandar el
// ticket por SMS evita depender del WhatsApp personal de la vendedora: se
// envía desde el backend con el número de la empresa, no desde su celular.
function isEnabled() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM);
}

function getClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSms(toRaw, body) {
  if (!isEnabled()) throw new Error("SMS no configurado (faltan variables TWILIO_SMS_FROM)");
  const client = getClient();
  return client.messages.create({
    from: process.env.TWILIO_SMS_FROM,
    to: normalizePhoneNumber(toRaw),
    body,
  });
}

module.exports = { isEnabled, sendSms };
