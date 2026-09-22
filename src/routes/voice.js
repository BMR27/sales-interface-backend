const express = require("express");
const authMiddleware = require("../middleware/auth");
const twilioSignatureMiddleware = require("../middleware/twilioSignature");
const { generateVoiceToken, buildDialTwiml } = require("../lib/twilioVoice");

const router = express.Router();

// POST /api/voice/token — el vendedor obtiene un Access Token para el Twilio Device del navegador
router.post("/token", authMiddleware, (req, res) => {
  try {
    const identity = `vendedor_${req.user.id}`;
    const token = generateVoiceToken(identity);
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/voice/twiml — webhook de Twilio (sin JWT, verificado por firma) que marca al lead
router.post("/twiml", twilioSignatureMiddleware, (req, res) => {
  const to = req.body.To;
  res.type("text/xml");
  res.send(buildDialTwiml(to));
});

module.exports = router;
