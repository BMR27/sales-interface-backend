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

// `record-from-answer-dual` arranca la grabación en el instante en que el
// cliente contesta -- no cuando empieza a sonar -- y guarda cada pierna en
// su propio canal. El tono de marcado no se graba.
//
// La llamada NO lleva aviso hablado: el consentimiento viene con el lead.
// Eso también significa que no hay nada entre el "bueno" del cliente y la
// vendedora: la llamada se conecta igual de rápido que sin grabar.
function buildDialTwiml(toNumber, { grabar = false, statusCallbackUrl = null } = {}) {
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

  dial.number(normalizePhoneNumber(toNumber));
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
  normalizePhoneNumber,
  vendedorIdDesdeFrom,
};
