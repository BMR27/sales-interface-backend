const express = require("express");
const authMiddleware = require("../middleware/auth");
const { checkCoverage } = require("../lib/fullvector");

const router = express.Router();

// GET /api/coverage/check?zipCode=&colonia= -- cobertura FullVector, usada
// para calcular el costo de envío en el carrito (src/lib/shippingCost.js).
router.get("/check", authMiddleware, async (req, res) => {
  try {
    const { zipCode, colonia } = req.query;
    if (!zipCode) return res.status(400).json({ error: "zipCode requerido" });

    const covered = await checkCoverage(String(zipCode), colonia ? String(colonia) : undefined);
    res.json({ covered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
