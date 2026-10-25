const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const twilioSignatureMiddleware = require("../middleware/twilioSignature");
const { generateVoiceToken, buildDialTwiml, vendedorIdDesdeFrom } = require("../lib/twilioVoice");
const { getParametros } = require("../lib/parametros");
const { registrarIntento, registrarDesenlace } = require("../lib/historialLlamadas");

const router = express.Router();
const prisma = new PrismaClient();

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

// GET /api/voice/grabacion-activa — le dice a la vendedora si su empresa
// graba, para poder mostrarlo en el panel de llamada. Que la persona que
// llama sepa que se la está grabando no es opcional.
router.get("/grabacion-activa", authMiddleware, async (req, res) => {
  try {
    const { grabacionLlamadas } = await getParametros(req.user.tenantId);
    res.json({ grabando: grabacionLlamadas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/voice/twiml — webhook de Twilio (sin JWT, verificado por firma) que marca al lead
router.post("/twiml", twilioSignatureMiddleware, async (req, res) => {
  const callSid = req.body.CallSid;
  // A que numero se marca lo decide el servidor, NO el navegador. Antes
  // venia en `To` desde el cliente; ahora la vendedora ya no conoce el
  // telefono completo (solo los ultimos 4 digitos, ver src/lib/telefono.js)
  // y mandarselo para que lo reenviara habria hecho inutil el ocultamiento.
  // Se resuelve del lead, que ademas es la unica fuente confiable.
  let to = null;

  // Quién llama sale del `From`, que deriva de la identidad del Access
  // Token; el leadId viaja por el navegador, así que sólo se acepta si de
  // verdad es un lead de esa vendedora.
  const vendedorId = vendedorIdDesdeFrom(req.body.From);
  const leadIdCrudo = Number(req.body.leadId);

  let grabar = false;

  try {
    const vendedor = vendedorId
      ? await prisma.user.findUnique({ where: { id: vendedorId }, select: { id: true, tenantId: true } })
      : null;

    if (vendedor?.tenantId && callSid) {
      const params = await getParametros(vendedor.tenantId);
      grabar = params.grabacionLlamadas;

      const lead = Number.isInteger(leadIdCrudo)
        ? await prisma.lead.findFirst({
            where: { id: leadIdCrudo, vendedorId: vendedor.id },
            select: { id: true, status: true, telefono: true },
          })
        : null;

      // Solo se marca a un lead que de verdad es de quien llama.
      if (lead) to = lead.telefono;

      // El intento queda registrado SIEMPRE, se grabe o no: el historial de
      // "cuántas veces se le ha llamado" no puede depender de un parámetro
      // de grabación que la empresa puede tener apagado.
      if (lead) {
        await registrarIntento({
          leadId: lead.id,
          vendedorId: vendedor.id,
          tenantId: vendedor.tenantId,
          callSid,
          estadoAntes: lead.status,
        });
      }

      if (grabar) {
        // La fila nace aquí, con lo único que se sabe al arrancar: a quién
        // corresponde la llamada. El RecordingSid llega después, por el
        // webhook de grabación.
        await prisma.grabacionLlamada.upsert({
          where: { callSid },
          create: {
            callSid,
            leadId: lead?.id ?? null,
            vendedorId: vendedor.id,
            tenantId: vendedor.tenantId,
          },
          update: {},
        });
      }
    }
  } catch (err) {
    // Un fallo registrando no puede tumbar la llamada: se marca igual, sin
    // grabar, y queda el error en el monitoreo.
    console.error("no se pudo preparar el registro de la llamada", callSid, err);
    grabar = false;
  }

  res.type("text/xml");

  // Sin lead resoluble no hay a quién marcar: puede ser un lead que ya no es
  // de esa vendedora, o un leadId manipulado. Antes el número venía del
  // navegador y esto no podía pasar; ahora hay que decirlo en vez de marcar
  // a un número vacío, que Twilio intentaría igual.
  if (!to) {
    console.error("no se pudo resolver a quién marcar", { callSid, from: req.body.From });
    return res.send(
      '<Response><Say language="es-MX" voice="Polly.Mia">No se pudo iniciar la llamada. Vuelve a intentarlo desde el panel.</Say></Response>',
    );
  }

  const base = process.env.BACKEND_PUBLIC_URL;
  const statusCallbackUrl = base ? `${base}/api/voice/grabacion-status` : null;

  res.send(
    buildDialTwiml(to, {
      // Sin BACKEND_PUBLIC_URL no hay webhook al que Twilio pueda avisar
      // cuando termine la grabación: grabar sin poder registrar el audio
      // sería cobrar almacenamiento por algo que nadie podría escuchar.
      grabar: grabar && !!statusCallbackUrl,
      statusCallbackUrl,
      accionUrl: base ? `${base}/api/voice/llamada-fin` : null,
    }),
  );
});

// POST /api/voice/llamada-fin — Twilio avisa aquí al terminar el <Dial>,
// con DialCallStatus y DialCallDuration. Es la única fuente que dice si el
// cliente llegó a contestar, y llega siempre: a diferencia del webhook de
// grabación, no depende de que haya audio.
//
// Devuelve TwiML vacío a propósito: si no se responde nada, Twilio sigue
// ejecutando el documento original y la llamada no cuelga limpio.
router.post("/llamada-fin", twilioSignatureMiddleware, async (req, res) => {
  res.type("text/xml");
  res.send("<Response/>");

  try {
    const { CallSid, DialCallStatus, DialCallDuration } = req.body;
    if (!CallSid) return;

    await registrarDesenlace({
      callSid: CallSid,
      desenlace: DialCallStatus,
      duracion: Number(DialCallDuration),
    });

    // Una llamada que nadie contestó no va a generar audio, y su fila de
    // grabación se quedaría en EN_CURSO para siempre aparentando que algo
    // sigue pendiente. Aquí se cierra con el motivo real.
    if (DialCallStatus && DialCallStatus !== "completed") {
      await prisma.grabacionLlamada.updateMany({
        where: { callSid: CallSid, estado: "EN_CURSO" },
        data: { estado: "FALLIDA", error: DialCallStatus },
      });
    }
  } catch (err) {
    console.error("no se pudo registrar el fin de la llamada", err);
  }
});

// POST /api/voice/grabacion-status — webhook de Twilio al terminar la
// grabación. Completa la fila que creó /twiml con el id del audio.
router.post("/grabacion-status", twilioSignatureMiddleware, async (req, res) => {
  // Twilio reintenta si no respondemos rápido, y un reintento con la fila ya
  // escrita no debe producir nada distinto: se contesta 204 siempre.
  res.sendStatus(204);

  try {
    const { CallSid, RecordingSid, RecordingDuration, RecordingStatus } = req.body;
    if (!CallSid) return;

    const existente = await prisma.grabacionLlamada.findUnique({ where: { callSid: CallSid } });
    if (!existente) return;

    // "absent" es Twilio diciendo que no hubo audio que guardar (nadie
    // contestó, colgaron antes): es un desenlace normal, no un error.
    const completada = RecordingStatus === "completed" && RecordingSid;

    await prisma.grabacionLlamada.update({
      where: { callSid: CallSid },
      data: completada
        ? {
            recordingSid: RecordingSid,
            estado: "COMPLETADA",
            duracion: Number(RecordingDuration) || null,
            grabadaAt: new Date(),
          }
        : { estado: "FALLIDA", error: RecordingStatus || "sin audio" },
    });
  } catch (err) {
    console.error("no se pudo guardar el estado de la grabación", err);
  }
});

module.exports = router;
