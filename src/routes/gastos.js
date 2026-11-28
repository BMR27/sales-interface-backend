// Gasto de Twilio contra lo recargado (ver src/lib/gastosTwilio.js).
// Sólo el ADMIN: son los números del dinero de la empresa.
const express = require("express");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const prisma = require("../lib/prisma");
const { inicioDeDia, finDeDia } = require("../lib/fechasLocales");
const { resumenGastos } = require("../lib/gastosTwilio");
const { detallarMovimiento } = require("../lib/auditoria");

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/gastos?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&vendedorId=
router.get("/", async (req, res) => {
  try {
    const desde = inicioDeDia(req.query.desde);
    const hasta = finDeDia(req.query.hasta);
    if (!desde || !hasta) return res.status(400).json({ error: "Hay que indicar el periodo: desde y hasta" });
    if (desde > hasta) return res.status(400).json({ error: "La fecha inicial es posterior a la final" });
    const vendedorId = req.query.vendedorId ? Number(req.query.vendedorId) : null;

    const [resumen, personas] = await Promise.all([
      resumenGastos(req.user.tenantId, { desde, hasta, vendedorId }),
      // Para el filtro: quienes generan gasto (llaman o mandan mensajes),
      // sólo activas.
      prisma.user.findMany({
        where: { tenantId: req.user.tenantId, activo: true, rol: { in: ["VENDEDOR", "COORDINADOR", "ADMIN_OPERATIVO", "ADMIN"] } },
        select: { id: true, nombre: true, rol: true },
        orderBy: { nombre: "asc" },
      }),
    ]);
    res.json({ ...resumen, personas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/gastos/recargas { monto, fecha, nota }
router.post("/recargas", async (req, res) => {
  try {
    const monto = Number(req.body?.monto);
    const fecha = req.body?.fecha ? new Date(req.body.fecha) : new Date();
    if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: "El monto debe ser mayor a 0" });
    if (Number.isNaN(fecha.getTime())) return res.status(400).json({ error: "Fecha inválida" });
    if (fecha > new Date(Date.now() + 60 * 1000)) return res.status(400).json({ error: "La fecha no puede ser futura" });
    const recarga = await prisma.recargaTwilio.create({
      data: {
        tenantId: req.user.tenantId, monto, fecha,
        nota: req.body?.nota ? String(req.body.nota).slice(0, 300) : null,
        creadoPorId: req.user.id, creadoPorNombre: req.user.nombre || null,
      },
    });
    detallarMovimiento(req, { entidad: "RecargaTwilio", entidadId: recarga.id, descripcion: `Registró una recarga de Twilio de $${monto.toLocaleString("es-MX")}` });
    res.status(201).json(recarga);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/admin/gastos/recargas/:id — para corregir una captura.
router.delete("/recargas/:id", async (req, res) => {
  try {
    const recarga = await prisma.recargaTwilio.findFirst({ where: { id: Number(req.params.id), tenantId: req.user.tenantId } });
    if (!recarga) return res.status(404).json({ error: "Recarga no encontrada" });
    await prisma.recargaTwilio.delete({ where: { id: recarga.id } });
    detallarMovimiento(req, { entidad: "RecargaTwilio", entidadId: recarga.id, descripcion: `Borró una recarga de Twilio de $${recarga.monto.toLocaleString("es-MX")}`, antes: recarga });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
