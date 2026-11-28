// Bitácora de cada SMS y WhatsApp que sale, para el gasto de Twilio (ver
// src/lib/gastosTwilio.js): quién lo mandó, por qué, y cuántos segmentos
// cobró Twilio -- un SMS largo o con acentos se parte en varios y cada uno
// se cobra. Nunca lanza: el mensaje ya salió, la bitácora no lo detiene.
const prisma = require("./prisma");

async function registrarMensaje(mensaje, { tenantId, userId = null, leadId = null, canal, motivo }) {
  if (!tenantId || !mensaje) return;
  try {
    await prisma.mensajeEnviado.create({
      data: {
        tenantId,
        userId,
        leadId,
        canal,
        motivo,
        segmentos: Math.max(1, Number(mensaje.numSegments) || 1),
        twilioSid: mensaje.sid || null,
      },
    });
  } catch (err) {
    console.error("no se pudo registrar el mensaje enviado", mensaje.sid, err.message);
  }
}

module.exports = { registrarMensaje };
