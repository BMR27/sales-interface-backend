const express = require("express");
const { PrismaClient } = require("@prisma/client");
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const { getParametros } = require("../lib/parametros");
const { LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");

const router = express.Router();
const prisma = new PrismaClient();

// Estadísticas del tablero de Admin. Es sólo para ADMIN: el resto de los
// roles tiene sus propias vistas y no deben cambiar.
router.use(authMiddleware, adminMiddleware);

function inicioDelDia(fecha) {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  return d;
}

function diaISO(fecha) {
  return inicioDelDia(fecha).toISOString().slice(0, 10);
}

// Variación porcentual contra el periodo anterior. null cuando no hay base
// de comparación: un "+100%" saliendo de cero no dice nada.
function variacion(actual, anterior) {
  if (!anterior) return null;
  return Math.round(((actual - anterior) / anterior) * 100);
}

// GET /api/admin/estadisticas?dias=30
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);

    const ahora = new Date();
    const desde = inicioDelDia(new Date(ahora.getTime() - (dias - 1) * 86400000));
    // Mismo tamaño de ventana justo antes, para comparar manzanas con manzanas.
    const desdeAnterior = inicioDelDia(new Date(desde.getTime() - dias * 86400000));

    const inicioDia = inicioDelDia(ahora);
    const inicioSemana = inicioDelDia(new Date(ahora.getTime() - ahora.getDay() * 86400000));
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

    const [
      parametros,
      ventasHoy, ventasSemana, ventasMes,
      ventasPeriodo, ventasPeriodoAnterior,
      leadsPeriodo, leadsPeriodoAnterior,
      leadsPorStatus, leadsPorSource,
      sinAsignar, leadsHoyApi,
      ventasDetalle, leadsDetalle,
      vendedores, leadsPorVendedor, ventasPorVendedor,
      llamadasPeriodo,
      itemsVendidos,
      fullvector,
      entregas,
      recentLeads, recentVentas,
    ] = await Promise.all([
      getParametros(tenantId),

      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: inicioDia } }, _sum: { monto: true, comision: true, costoEnvio: true }, _count: true }),
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: inicioSemana } }, _sum: { monto: true, comision: true }, _count: true }),
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: inicioMes } }, _sum: { monto: true, comision: true }, _count: true }),

      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: desde } }, _sum: { monto: true, comision: true }, _count: true }),
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: desdeAnterior, lt: desde } }, _sum: { monto: true }, _count: true }),

      prisma.lead.count({ where: { tenantId, createdAt: { gte: desde } } }),
      prisma.lead.count({ where: { tenantId, createdAt: { gte: desdeAnterior, lt: desde } } }),

      prisma.lead.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
      prisma.lead.groupBy({ by: ["source"], where: { tenantId, createdAt: { gte: desde } }, _count: true }),

      prisma.lead.count({ where: { tenantId, vendedorId: null } }),
      prisma.lead.count({ where: { tenantId, source: "EXTERNAL_API", createdAt: { gte: inicioDia } } }),

      // Para las series por día: se traen las filas crudas y se agrupan en
      // memoria. Son volúmenes de semanas, no de años.
      prisma.venta.findMany({ where: { tenantId, fecha: { gte: desde } }, select: { fecha: true, monto: true, comision: true } }),
      prisma.lead.findMany({ where: { tenantId, createdAt: { gte: desde } }, select: { createdAt: true, status: true } }),

      prisma.user.findMany({ where: { rol: "VENDEDOR", tenantId }, select: { id: true, nombre: true, email: true, activo: true } }),
      prisma.lead.groupBy({ by: ["vendedorId", "status"], where: { tenantId }, _count: true }),
      prisma.venta.groupBy({ by: ["vendedorId"], where: { tenantId, fecha: { gte: desde } }, _sum: { monto: true, comision: true }, _count: true }),

      prisma.llamada.count({ where: { tenantId, fecha: { gte: desde } } }),

      prisma.leadItem.groupBy({ by: ["productoId"], where: { tenantId }, _sum: { cantidad: true }, _count: true }),

      prisma.venta.groupBy({ by: ["fullvectorSyncStatus"], where: { tenantId }, _count: true }),
      prisma.venta.aggregate({ where: { tenantId, fecha: { gte: desde } }, _count: { entregaExitosa: true } }),

      prisma.lead.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 8, include: { vendedor: { select: { id: true, nombre: true } } } }),
      prisma.venta.findMany({
        where: { tenantId }, orderBy: { fecha: "desc" }, take: 8,
        include: { lead: { select: { producto: true, nombre: true } }, vendedor: { select: { id: true, nombre: true } } },
      }),
    ]);

    // --- Serie diaria: leads que entraron y ventas cerradas, día por día ---
    const serie = new Map();
    for (let i = 0; i < dias; i++) {
      const clave = diaISO(new Date(desde.getTime() + i * 86400000));
      serie.set(clave, { dia: clave, leads: 0, ventas: 0, monto: 0, concretados: 0 });
    }
    for (const l of leadsDetalle) {
      const e = serie.get(diaISO(l.createdAt));
      if (!e) continue;
      e.leads += 1;
      if (l.status === "VENTA") e.concretados += 1;
    }
    for (const v of ventasDetalle) {
      const e = serie.get(diaISO(v.fecha));
      if (!e) continue;
      e.ventas += 1;
      e.monto += v.monto;
    }

    // --- Por vendedora: carga, resultado y conversión ---
    const porVendedor = Object.fromEntries(
      vendedores.map((v) => [v.id, {
        id: v.id, nombre: v.nombre, email: v.email, activo: v.activo,
        asignados: 0, abiertos: 0, concretados: 0, descartados: 0,
        ventas: 0, monto: 0, comision: 0, conversion: 0,
      }])
    );
    for (const row of leadsPorVendedor) {
      const b = porVendedor[row.vendedorId];
      if (!b) continue;
      b.asignados += row._count;
      if (row.status === "VENTA") b.concretados += row._count;
      else if (row.status === "DESCARTADO") b.descartados += row._count;
      if (LEAD_STATUSES_ABIERTOS.includes(row.status)) b.abiertos += row._count;
    }
    for (const row of ventasPorVendedor) {
      const b = porVendedor[row.vendedorId];
      if (!b) continue;
      b.ventas = row._count;
      b.monto = row._sum.monto || 0;
      b.comision = row._sum.comision || 0;
    }
    const equipo = Object.values(porVendedor)
      .map((v) => ({ ...v, conversion: v.asignados > 0 ? Math.round((v.concretados / v.asignados) * 100) : 0 }))
      .sort((a, b) => b.monto - a.monto);

    // --- Productos más vendidos ---
    const productos = await prisma.producto.findMany({
      where: { tenantId, id: { in: itemsVendidos.map((i) => i.productoId) } },
      select: { id: true, sku: true, nombre: true, stock: true },
    });
    const nombrePorProducto = Object.fromEntries(productos.map((p) => [p.id, p]));
    const topProductos = itemsVendidos
      .map((i) => ({
        id: i.productoId,
        sku: nombrePorProducto[i.productoId]?.sku ?? "?",
        nombre: nombrePorProducto[i.productoId]?.nombre ?? "Producto eliminado",
        stock: nombrePorProducto[i.productoId]?.stock ?? null,
        piezas: i._sum.cantidad || 0,
        veces: i._count,
      }))
      .sort((a, b) => b.piezas - a.piezas)
      .slice(0, 8);

    // --- Embudo y conversión global ---
    const statusMap = leadsPorStatus.reduce((acc, c) => ({ ...acc, [c.status]: c._count }), {});
    const totalLeads = Object.values(statusMap).reduce((s, n) => s + n, 0);
    const concretados = statusMap.VENTA || 0;

    const montoPeriodo = ventasPeriodo._sum.monto || 0;
    const montoAnterior = ventasPeriodoAnterior._sum.monto || 0;

    res.json({
      rango: { dias, desde, hasta: ahora },

      ventas: {
        hoy: { monto: ventasHoy._sum.monto || 0, comision: ventasHoy._sum.comision || 0, envio: ventasHoy._sum.costoEnvio || 0, count: ventasHoy._count },
        semana: { monto: ventasSemana._sum.monto || 0, comision: ventasSemana._sum.comision || 0, count: ventasSemana._count },
        mes: { monto: ventasMes._sum.monto || 0, comision: ventasMes._sum.comision || 0, count: ventasMes._count },
        periodo: { monto: montoPeriodo, comision: ventasPeriodo._sum.comision || 0, count: ventasPeriodo._count },
      },

      // Comparación contra la ventana anterior del mismo tamaño.
      tendencia: {
        monto: variacion(montoPeriodo, montoAnterior),
        ventas: variacion(ventasPeriodo._count, ventasPeriodoAnterior._count),
        leads: variacion(leadsPeriodo, leadsPeriodoAnterior),
      },

      embudo: {
        leads: totalLeads,
        leadsPeriodo,
        llamadas: llamadasPeriodo,
        concretados,
        conversion: totalLeads > 0 ? Math.round((concretados / totalLeads) * 100) : 0,
        ticketPromedio: ventasPeriodo._count > 0 ? Math.round(montoPeriodo / ventasPeriodo._count) : 0,
        entregasExitosas: entregas._count.entregaExitosa || 0,
      },

      leads: {
        porStatus: LEAD_STATUSES.map((s) => ({ status: s, label: LEAD_STATUS_LABELS[s], total: statusMap[s] || 0 })),
        porSource: leadsPorSource.map((s) => ({ source: s.source, total: s._count })),
        sinAsignar,
        hoyApi: leadsHoyApi,
      },

      serie: Array.from(serie.values()),
      equipo,
      topProductos,

      // Salud operativa: ventas que no llegaron a FullVector.
      sincronizacion: fullvector.reduce((acc, f) => ({ ...acc, [f.fullvectorSyncStatus]: f._count }), {}),

      metas: {
        metaMensual: parametros.metaMensual,
        avanceMes: parametros.metaMensual > 0 ? Math.round(((ventasMes._sum.monto || 0) / parametros.metaMensual) * 100) : 0,
        asignacionAutomatica: parametros.asignacionAutomatica,
      },

      recentLeads,
      recentVentas,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
