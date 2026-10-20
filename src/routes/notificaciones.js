const express = require("express");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { isEnabled, sendMail, parseDestinatarios } = require("../lib/mailer");
const { getConfig, setConfig } = require("../lib/notificaciones");
const { detallarMovimiento } = require("../lib/auditoria");

const router = express.Router();

router.use(authMiddleware, adminMiddleware);

// GET /api/admin/notificaciones
router.get("/", async (req, res) => {
  try {
    const config = await getConfig(req.user.tenantId);
    res.json({
      ...config,
      // El transporte se configura por variables de entorno; si falta, el
      // admin necesita saber que su configuración no va a enviar nada.
      transporteListo: isEnabled(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// PUT /api/admin/notificaciones
router.put("/", async (req, res) => {
  try {
    const { activo, destinatarios } = req.body;

    let lista;
    if (destinatarios !== undefined) {
      lista = Array.isArray(destinatarios) ? destinatarios : parseDestinatarios(destinatarios);
      const crudos = Array.isArray(destinatarios)
        ? destinatarios.filter(Boolean)
        : String(destinatarios || "").split(/[,;\s]+/).filter(Boolean);
      if (crudos.length !== lista.length) {
        return res.status(400).json({ error: "Hay correos con formato inválido" });
      }
    }

    const antes = await getConfig(req.user.tenantId);
    const config = await setConfig(req.user.tenantId, {
      activo: activo === undefined ? undefined : Boolean(activo),
      destinatarios: lista,
    });

    detallarMovimiento(req, {
      antes: { activo: antes.activo, destinatarios: antes.destinatarios },
      despues: { activo: config.activo, destinatarios: config.destinatarios },
    });

    res.json({ ...config, transporteListo: isEnabled() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/notificaciones/prueba — manda un correo de prueba a los
// destinatarios configurados, para no tener que esperar a que entre un lead
// real para saber si quedó bien.
router.post("/prueba", async (req, res) => {
  try {
    if (!isEnabled()) {
      return res.status(503).json({ error: "Correo no configurado: falta RESEND_API_KEY o MAIL_FROM" });
    }

    const config = await getConfig(req.user.tenantId);
    if (config.destinatarios.length === 0) {
      return res.status(400).json({ error: "No hay destinatarios configurados" });
    }

    await sendMail({
      to: config.destinatarios,
      subject: "Correo de prueba — notificaciones de leads",
      html: `<div style="font-family:system-ui,sans-serif;color:#1f2430">
        <h2 style="font-size:18px;margin:0 0 8px">Las notificaciones están funcionando</h2>
        <p style="font-size:14px;color:#4b5563">Si estás leyendo esto, los avisos de leads nuevos van a llegar a este buzón.</p>
        <p style="font-size:13px;color:#6b7280">Prueba enviada por ${req.user.nombre || req.user.email} · ${new Date().toLocaleString("es-MX")}</p>
      </div>`,
      text: "Las notificaciones de leads nuevos están funcionando.",
    });

    res.json({ ok: true, enviadoA: config.destinatarios });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message || "No se pudo enviar el correo" });
  }
});

module.exports = router;
