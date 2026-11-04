// Quien ha tocado este lead, para decidir a quien dárselo ahora.
//
// Antes de repartir, la coordinadora necesita responder tres preguntas que
// `Lead.vendedorId` no puede contestar porque solo guarda el presente:
//
//   ¿quien lo tuvo la ultima vez?      -- para no devolvérselo a ciegas
//   ¿a quien ya se le dio HOY?         -- para no repetir el mismo intento
//   ¿quien genero la rellamada?        -- esa ya hablo con el cliente
//
// El kardex tampoco sirve: es texto para auditar, y no se puede consultar
// por vendedora sin escarbar en JSON fila por fila. De ahi la tabla
// `lead_asignaciones` (ver schema.prisma).
//
// Los indicadores son INFORMATIVOS, nunca bloqueos. El documento es
// explicito: ninguna vendedora desaparece del selector y la coordinadora
// puede elegir a cualquiera de las habilitadas. Lo que cambia es que ahora
// elige sabiendo.
const prisma = require("./prisma");
const { inicioDeHoy } = require("./fechasLocales");

// Contexto de asignacion para un lote de leads.
//
// Devuelve un Map<leadId, contexto>. Se resuelve en DOS consultas para
// todo el lote y no una por lead: la cola dibuja 60 tarjetas, y una
// consulta por tarjeta convertiria abrir Leads en 120 viajes a la base.
async function contextoDeAsignacion(leadIds, tenantId) {
  const vacio = new Map();
  if (!leadIds?.length || !tenantId) return vacio;

  const desdeHoy = inicioDeHoy();

  const [movimientos, hoy] = await Promise.all([
    // El ultimo movimiento de cada lead. Se traen los recientes y se filtra
    // en memoria: Prisma no tiene un "distinct on" por grupo, y traer el
    // historial completo de leads viejos seria peor.
    prisma.leadAsignacion.findMany({
      where: { leadId: { in: leadIds }, tenantId },
      orderBy: { createdAt: "desc" },
      take: leadIds.length * 6,
      select: {
        leadId: true,
        evento: true,
        createdAt: true,
        vendedorAnteriorId: true,
        vendedorAnteriorNombre: true,
        vendedorNuevoId: true,
        vendedorNuevoNombre: true,
      },
    }),
    // A quien se le asigno hoy, sin importar si todavia lo tiene. Es la
    // pregunta del documento: "vendedoras a quienes se asigno ese lead
    // durante el dia".
    prisma.leadAsignacion.findMany({
      where: {
        leadId: { in: leadIds },
        tenantId,
        createdAt: { gte: desdeHoy },
        vendedorNuevoId: { not: null },
      },
      select: { leadId: true, vendedorNuevoId: true, vendedorNuevoNombre: true },
    }),
  ]);

  const ctx = new Map(leadIds.map((id) => [id, { ultimaVendedora: null, asignadasHoy: [] }]));

  // La ultima vendedora: la primera que aparezca al recorrer de lo mas
  // nuevo a lo mas viejo. Se mira `vendedorAnterior` en las devoluciones y
  // `vendedorNuevo` en las asignaciones, porque segun el evento el dato
  // vive en una columna o en la otra.
  for (const m of movimientos) {
    const c = ctx.get(m.leadId);
    if (!c || c.ultimaVendedora) continue;
    const id = m.vendedorAnteriorId ?? m.vendedorNuevoId;
    const nombre = m.vendedorAnteriorNombre ?? m.vendedorNuevoNombre;
    if (id && nombre) c.ultimaVendedora = { id, nombre };
  }

  for (const a of hoy) {
    const c = ctx.get(a.leadId);
    if (!c || !a.vendedorNuevoId) continue;
    if (!c.asignadasHoy.some((v) => v.id === a.vendedorNuevoId)) {
      c.asignadasHoy.push({ id: a.vendedorNuevoId, nombre: a.vendedorNuevoNombre });
    }
  }

  return ctx;
}

// Cuantos leads recibio hoy cada vendedora.
//
// Lo pide el documento ("cantidad de asignaciones recibidas hoy por cada
// vendedora") y responde a algo que la coordinadora hacia de memoria:
// repartir parejo. Se cuenta sobre la bitacora y no sobre `Lead.asignadoAt`
// porque un lead que se asigno y volvio a la cola el mismo dia SI consumio
// trabajo de esa vendedora, y `asignadoAt` ya se habria borrado.
async function asignacionesDeHoy(tenantId) {
  if (!tenantId) return new Map();

  const filas = await prisma.leadAsignacion.groupBy({
    by: ["vendedorNuevoId"],
    where: {
      tenantId,
      createdAt: { gte: inicioDeHoy() },
      vendedorNuevoId: { not: null },
      evento: { in: ["asignada", "reasignada"] },
    },
    _count: true,
  });

  return new Map(filas.map((f) => [f.vendedorNuevoId, f._count]));
}

// La bitacora completa de un lead, para la cronologia.
async function asignacionesDeLead(leadId, tenantId) {
  return prisma.leadAsignacion.findMany({
    where: { leadId, tenantId },
    orderBy: { createdAt: "desc" },
  });
}

module.exports = { contextoDeAsignacion, asignacionesDeHoy, asignacionesDeLead };
