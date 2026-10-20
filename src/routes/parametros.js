const express = require("express");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { DEFINICION, getParametros, setParametros } = require("../lib/parametros");
const { detallarMovimiento } = require("../lib/auditoria");

const router = express.Router();

// GET /api/admin/parametros — valores + su definición, para que la pantalla
// de Configuración se arme sola a partir del catálogo y no haya que tocarla
// cada vez que se agrega un parámetro.
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const valores = await getParametros(req.user.tenantId);
    res.json({ valores, definicion: DEFINICION });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/parametros
router.put("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const antes = await getParametros(req.user.tenantId);
    const { valores, errores } = await setParametros(req.user.tenantId, req.body);

    if (errores) return res.status(400).json({ error: errores.join(". ") });

    detallarMovimiento(req, { antes, despues: valores });
    res.json({ valores, definicion: DEFINICION });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
