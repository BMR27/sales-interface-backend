const twilio = require("twilio");

function twilioSignatureMiddleware(req, res, next) {
  const signature = req.headers["x-twilio-signature"];
  const url = `${process.env.BACKEND_PUBLIC_URL}${req.originalUrl}`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
  if (!valid) {
    return res.status(403).send("Invalid Twilio signature");
  }
  next();
}

module.exports = twilioSignatureMiddleware;
