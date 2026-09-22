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

function buildDialTwiml(toNumber) {
  const twiml = new VoiceResponse();
  const dial = twiml.dial({ callerId: process.env.TWILIO_CALLER_ID });
  dial.number(normalizePhoneNumber(toNumber));
  return twiml.toString();
}

module.exports = { generateVoiceToken, buildDialTwiml, normalizePhoneNumber };
