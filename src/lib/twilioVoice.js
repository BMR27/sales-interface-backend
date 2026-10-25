const twilio = require("twilio");

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const VoiceResponse = twilio.twiml.VoiceResponse;

function generateVoiceToken(identity) {
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow: false,
  });

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );
  token.addGrant(voiceGrant);
  return token.toJwt();
}

// Normaliza a E.164 asumiendo México (+52) cuando no viene con lada de país
function normalizePhoneNumber(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+52${digits}`;
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;
  return `+${digits}`;
}

const AVISO_GRABACION =
  "Esta llamada puede ser grabada con fines de calidad y capacitación.";

// `grabar` enciende la grabación de ambos lados (dual) desde que contestan,
// no desde que suena: el tono de marcado no aporta nada y sí consume
// almacenamiento.
//
// El aviso va en el `url` del <Number>, no en un <Say> antes del <Dial>.
// La diferencia importa: un <Say> suelto lo oye la vendedora, que es la
// pierna que origina la llamada, y el cliente -- que es a quien hay que
// informar -- no se enteraría de nada. El `url` del <Number> se reproduce
// a quien contesta, justo antes de unir las dos piernas.
function buildDialTwiml(
  toNumber,
  { grabar = false, avisar = false, statusCallbackUrl = null, avisoUrl = null } = {},
) {
  const twiml = new VoiceResponse();

  const dial = twiml.dial({
    callerId: process.env.TWILIO_CALLER_ID,
    ...(grabar
      ? {
          record: "record-from-answer-dual",
          recordingStatusCallback: statusCallbackUrl,
          recordingStatusCallbackEvent: "completed absent",
        }
      : {}),
  });

  const anunciar = grabar && avisar && avisoUrl;
  dial.number(anunciar ? { url: avisoUrl } : {}, normalizePhoneNumber(toNumber));
  return twiml.toString();
}

// TwiML que oye el cliente al contestar, antes de que se una la llamada.
function buildAvisoTwiml() {
  const twiml = new VoiceResponse();
  twiml.say({ language: "es-MX", voice: "Polly.Mia" }, AVISO_GRABACION);
  return twiml.toString();
}

// La identidad del Access Token la emite el servidor (`vendedor_<id>` en
// routes/voice.js), asi que el `From` del webhook es la unica parte del
// cuerpo en la que se puede confiar para saber quien llama. Todo lo demas
// viaja por el navegador y es manipulable.
function vendedorIdDesdeFrom(from) {
  const match = /^client:vendedor_(\d+)$/.exec(String(from || "").trim());
  return match ? Number(match[1]) : null;
}

module.exports = {
  generateVoiceToken,
  buildDialTwiml,
  buildAvisoTwiml,
  normalizePhoneNumber,
  vendedorIdDesdeFrom,
  AVISO_GRABACION,
};
