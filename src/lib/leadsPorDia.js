// Qué días (y a qué horas) entran los leads.
//
// La pregunta de operación es de personal: si los miércoles entran el doble
// que los viernes, el miércoles hace falta más gente marcando. Por eso se
// cuenta por DÍA DE LA SEMANA y no sólo por fecha, y se da el promedio por
// día además del total: en un periodo de 30 días puede haber 5 miércoles y
// 4 viernes, y comparar totales premiaría al día que más veces cayó.
//
// Todo en el reloj de la operación (México): un lead de las 11 de la noche
// del martes es del martes, aunque en UTC ya sea miércoles.
//
// La pantalla de Reportes y el Excel salen de aquí, para que digan lo mismo.
const prisma = require("./prisma");
const { diaLocal } = require("./fechasLocales");
const { momentoLocal } = require("./horariosVendedora");
const { LEAD_STATUS_LABELS } = require("./leadStatus");

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
// El orden de la semana de la operación: de lunes a domingo.
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0];

function origenDe(l) {
  if (l.origen) return l.origen;
  return l.source === "EXTERNAL_API" ? "API" : "Manual";
}

// Cuántas veces cae cada día de la semana en el periodo (para el promedio).
function ocurrencias(inicio, fin) {
  const n = [0, 0, 0, 0, 0, 0, 0];
  const fechas = [];
  const d = new Date(`${diaLocal(inicio)}T12:00:00Z`);
  const ultimo = diaLocal(fin);
  for (let i = 0; i < 400; i++) {
    const iso = d.toISOString().slice(0, 10);
    n[d.getUTCDay()] += 1;
    fechas.push({ fecha: iso, diaSemana: d.getUTCDay() });
    if (iso === ultimo) break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { n, fechas };
}

async function leadsPorDia(tenantId, inicio, fin, { conDetalle = false } = {}) {
  const leads = await prisma.lead.findMany({
    where: { tenantId, createdAt: { gte: inicio, lte: fin } },
    select: {
      id: true, folioPS: true, folio: true, createdAt: true, status: true, source: true, origen: true,
      producto: true, nombre: true,
      ...(conDetalle ? { vendedor: { select: { nombre: true } } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  const { n: veces, fechas } = ocurrencias(inicio, fin);
  const porDia = Array.from({ length: 7 }, (_, d) => ({
    diaSemana: d, dia: DIAS[d], leads: 0, concretados: 0, descartados: 0, abiertos: 0, veces: veces[d], origenes: {},
  }));
  const porHora = Array.from({ length: 7 }, () => Array(24).fill(0));
  const porFecha = new Map(fechas.map((f) => [f.fecha, { ...f, dia: DIAS[f.diaSemana], leads: 0, concretados: 0 }]));
  const origenes = new Set();

  for (const l of leads) {
    const { diaSemana, minuto } = momentoLocal(l.createdAt);
    const d = porDia[diaSemana];
    d.leads += 1;
    if (l.status === "VENTA") d.concretados += 1;
    else if (l.status === "DESCARTADO" || l.status === "NO_CONCRETADO") d.descartados += 1;
    else d.abiertos += 1;
    const o = origenDe(l);
    origenes.add(o);
    d.origenes[o] = (d.origenes[o] || 0) + 1;
    porHora[diaSemana][Math.floor(minuto / 60)] += 1;
    const f = porFecha.get(diaLocal(l.createdAt));
    if (f) {
      f.leads += 1;
      if (l.status === "VENTA") f.concretados += 1;
    }
  }

  const total = leads.length;
  const dias = porDia.map((d) => ({
    ...d,
    porcentaje: total ? d.leads / total : 0,
    promedio: d.veces ? d.leads / d.veces : 0,
    // De los que entraron ese día, cuántos ya se concretaron.
    tasaCierre: d.leads ? d.concretados / d.leads : 0,
  }));

  return {
    total,
    // Ranking: más leads primero; empate por promedio.
    ranking: [...dias].sort((a, b) => b.leads - a.leads || b.promedio - a.promedio),
    semana: ORDEN_SEMANA.map((i) => dias[i]),
    porHora: ORDEN_SEMANA.map((i) => ({ dia: DIAS[i], horas: porHora[i] })),
    porFecha: [...porFecha.values()],
    origenes: [...origenes].sort(),
    ...(conDetalle
      ? {
          detalle: leads.map((l) => {
            const { diaSemana, minuto } = momentoLocal(l.createdAt);
            return {
              folioPS: l.folioPS || "", folio: l.folio || "", nombre: l.nombre, producto: l.producto,
              fecha: l.createdAt, dia: DIAS[diaSemana], hora: Math.floor(minuto / 60),
              origen: origenDe(l), estatus: LEAD_STATUS_LABELS[l.status] || l.status,
              vendedora: l.vendedor?.nombre || "",
            };
          }),
        }
      : {}),
  };
}

module.exports = { leadsPorDia, DIAS };
