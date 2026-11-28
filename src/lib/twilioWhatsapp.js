const twilio = require("twilio");
const { normalizePhoneNumber } = require("./twilioVoice");
const { registrarMensaje } = require("./mensajesEnviados");

// WhatsApp de la empresa por Twilio, como el SMS de twilioSms.js: sale del
// número de Perfect Self y no del celular de la vendedora.
//
// WhatsApp no deja escribirle primero a un cliente con texto libre: fuera
// de la ventana de 24 horas que abre un mensaje suyo, sólo se pueden mandar
// plantillas aprobadas por Meta. Por eso aquí no hay `body` sino una
// plantilla de Twilio Content (contentSid) con sus variables.
//
// Se enciende sola cuando existen las dos variables:
//   TWILIO_WHATSAPP_FROM            el número dado de alta como remitente
//                                   de WhatsApp en Twilio (+52...)
//   TWILIO_WHATSAPP_LINK_PAGO_SID   la plantilla aprobada del link de pago
//                                   (HX...)
function isEnabled() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM &&
    process.env.TWILIO_WHATSAPP_LINK_PAGO_SID
  );
}

function conPrefijo(numero) {
  const limpio = String(numero || "").replace(/^whatsapp:/, "");
  return `whatsapp:${limpio}`;
}

// `variables` va por posición, como la plantilla: { 1: "...", 2: "..." }.
async function sendTemplate(toRaw, contentSid, variables, registro = null) {
  if (!isEnabled()) throw new Error("WhatsApp no configurado (faltan TWILIO_WHATSAPP_FROM o la plantilla)");
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const mensaje = await client.messages.create({
    from: conPrefijo(process.env.TWILIO_WHATSAPP_FROM),
    to: conPrefijo(normalizePhoneNumber(toRaw)),
    contentSid,
    contentVariables: JSON.stringify(variables),
  });
  if (registro) await registrarMensaje(mensaje, { ...registro, canal: "whatsapp" });
  return mensaje;
}

module.exports = { isEnabled, sendTemplate };
