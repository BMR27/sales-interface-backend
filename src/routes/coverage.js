const express = require("express");
const authMiddleware = require("../middleware/auth");
const { PrismaClient } = require("@prisma/client");
const { checkCoverage } = require("../lib/fullvector");

const prisma = new PrismaClient();

const router = express.Router();

// GET /api/coverage/check?zipCode=&colonia=&leadId= -- cobertura FullVector.
// Se usa para el costo de envío del carrito (src/lib/shippingCost.js) y para
// la marca FC FV del panel de llamada.
//
// Con `leadId` el resultado se guarda en el lead, así que la marca queda
// disponible en la lista sin volver a preguntar. Se guarda en cada consulta
// y no sólo la primera vez: la cobertura la manda FullVector y puede cambiar
// (cobertura nacional, un CP que se da de alta), y esta consulta ocurre en
// cada llamada.
router.get("/check", authMiddleware, async (req, res) => {
  try {
    const { zipCode, colonia, leadId } = req.query;
    if (!zipCode) return res.status(400).json({ error: "zipCode requerido" });

    const covered = await checkCoverage(String(zipCode), colonia ? String(colonia) : undefined);

    if (leadId && covered !== null) {
      // updateMany + tenantId: nadie puede etiquetar el lead de otro espacio.
      await prisma.lead.updateMany({
        where: { id: Number(leadId), tenantId: req.user.tenantId },
        data: { coberturaFv: covered, coberturaFvAt: new Date() },
      });
    }

    res.json({ covered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
