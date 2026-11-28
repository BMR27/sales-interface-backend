const twilio = require("twilio");
const { normalizePhoneNumber } = require("./twilioVoice");
const { registrarMensaje } = require("./mensajesEnviados");

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

// `registro` ({ tenantId, userId, leadId, motivo }) deja el envío en la
// bitácora de gasto (src/lib/mensajesEnviados.js).
async function sendSms(toRaw, body, registro = null) {
  if (!isEnabled()) throw new Error("SMS no configurado (faltan variables TWILIO_SMS_FROM)");
  const client = getClient();
  const mensaje = await client.messages.create({
    from: process.env.TWILIO_SMS_FROM,
    to: normalizePhoneNumber(toRaw),
    body,
  });
  if (registro) await registrarMensaje(mensaje, { ...registro, canal: "sms" });
  return mensaje;
}

module.exports = { isEnabled, sendSms };
