// La campana: avisos en pantalla del usuario que consulta.
//
// Vive en /api/notificaciones, separado de /api/admin/notificaciones, que es
// la configuración de los correos y sólo la toca el admin.
const express = require("express");
const authMiddleware = require("../middleware/auth");
const { listarAvisos, marcarLeida, marcarTodasLeidas, purgarViejas } = require("../lib/avisos");
const { sincronizarAvisos } = require("../lib/avisosProgreso");

const router = express.Router();

router.use(authMiddleware);

// GET /api/notificaciones — recalcula los avisos derivados y devuelve la lista.
router.get("/", async (req, res) => {
  try {
    // Un superadmin viendo un espacio ajeno (id null) no tiene campana propia.
    if (!req.user.id) return res.json({ items: [], noLeidas: 0 });

    // Los hitos se recalculan aquí mismo: abrir la campana es el único
    // momento en que de verdad importa que estén al día.
    await sincronizarAvisos(req.user);

    const { items, noLeidas } = await listarAvisos(req.user.id, { limite: req.query.limite });
    res.json({ items, noLeidas });

    // Después de responder: la limpieza no tiene por qué hacer esperar a nadie.
    purgarViejas(req.user.id);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/notificaciones/leer-todas
router.post("/leer-todas", async (req, res) => {
  try {
    if (!req.user.id) return res.json({ marcadas: 0 });
    const marcadas = await marcarTodasLeidas(req.user.id);
    res.json({ marcadas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/notificaciones/:id/leer
router.post("/:id/leer", async (req, res) => {
  try {
    if (!req.user.id) return res.json({ marcadas: 0 });
    const marcadas = await marcarLeida(req.user.id, req.params.id);
    res.json({ marcadas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
