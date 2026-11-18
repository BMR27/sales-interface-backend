const express = require("express");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { DEFINICION, getParametros, setParametros } = require("../lib/parametros");
const { detallarMovimiento } = require("../lib/auditoria");
const { CLAVE: CLAVE_FRENO, puedeFrenarLlamadas } = require("../lib/frenoLlamadas");

const router = express.Router();

// GET /api/admin/parametros — valores + su definición, para que la pantalla
// de Configuración se arme sola a partir del catálogo y no haya que tocarla
// cada vez que se agrega un parámetro.
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const valores = await getParametros(req.user.tenantId);
    res.json({
      valores,
      definicion: DEFINICION,
      // El freno de llamadas no lo maneja cualquier administrador: la
      // pantalla usa esto para no dibujar un botón que el servidor va a
      // rechazar. El permiso real se comprueba abajo, en el PUT.
      puedeFrenarLlamadas: puedeFrenarLlamadas(req.user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/parametros
router.put("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // El freno se comprueba AQUÍ y no solo escondiendo el botón: ocultar
    // un control no impide llamar al endpoint, y éste para a toda la
    // operación. Solo se rechaza si de verdad viene en el cuerpo, para no
    // bloquear un guardado normal de los demás parámetros.
    if (CLAVE_FRENO in (req.body || {}) && !puedeFrenarLlamadas(req.user)) {
      return res.status(403).json({
        error: "Solo el administrador autorizado puede bloquear o reanudar las llamadas",
      });
    }

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
