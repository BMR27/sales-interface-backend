const express = require("express");
const ExcelJS = require("exceljs");
const authMiddleware = require("../middleware/auth");
const coordinacionMiddleware = require("../middleware/coordinacion");
const { detallarMovimiento } = require("../lib/auditoria");
const { getParametros } = require("../lib/parametros");
const { calcularQuincenaVendedora, calcularQuincenaCoordinadoras } = require("../lib/comisiones");
const { crearAviso, crearAvisos } = require("../lib/avisos");

const router = express.Router();
const prisma = require("../lib/prisma");
const { inicioDeDia, finDeDia, inicioDeHoy, diaLocal } = require("../lib/fechasLocales");
const { filtroDisponible } = require("../lib/protocoloLeads");
const { dondeRepartible, dondeEnEspera } = require("../lib/colaLeads");
const { describirLeads } = require("../lib/semaforoLead");
const { emitir } = require("../lib/eventos");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");
const { grupoDe, agrupar, esNuevoDeHoy, motivoDeAtraso } = require("../lib/colaCoordinacion");
const { contextoDeAsignacion, asignacionesDeHoy } = require("../lib/historialAsignaciones");
const { registrarAsignacion } = require("../lib/cicloLead");

router.use(authMiddleware, coordinacionMiddleware);

// Agrupaciones que usa el coordinador en su historial. Con cuatro estatus
// cada grupo es uno solo, pero se mantiene la forma de lista porque los
// nombres de grupo son parte del contrato del filtro ?estado=.
const STATUS_GROUPS = {
  PENDIENTE: ["NUEVO"],
  CONCRETADA: ["VENTA"],
  RECHAZADA: ["DESCARTADO"],
  REAGENDADA: ["REAGENDADO"],
  // Grupo propio, no mezclado con RECHAZADA: un lead que se cerro porque se
  // agotaron las 72 horas sin contacto no es un rechazo, y meterlo en el
  // mismo filtro impediria a la coordinadora distinguir lo que su equipo
  // trabajo y no cerro de lo que el cliente rechazo.
  NO_CONCRETADA: ["NO_CONCRETADO"],
};

function classify(status) {
  if (STATUS_GROUPS.CONCRETADA.includes(status)) return "concretada";
  if (STATUS_GROUPS.RECHAZADA.includes(status)) return "rechazada";
  if (STATUS_GROUPS.NO_CONCRETADA.includes(status)) return "noConcretada";
  if (STATUS_GROUPS.REAGENDADA.includes(status)) return "reagendada";
  return "pendiente";
}

// GET /api/coordinador/overview
router.get("/overview", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // Hora de la operacion, no del servidor en UTC (fechasLocales.js).
    const inicioDia = inicioDeHoy();

    const [vendedores, grouped, ventasHoy, repartibles, enEspera] = await Promise.all([
      prisma.user.findMany({ where: { rol: "VENDEDOR", tenantId }, select: { id: true, nombre: true } }),
      prisma.lead.groupBy({ by: ["vendedorId", "status"], where: { tenantId }, _count: true }),
      prisma.venta.groupBy({
        by: ["vendedorId"],
        where: { tenantId, fecha: { gte: inicioDia } },
        _sum: { monto: true, comision: true },
      }),
      // Los dos conteos de la cola salen de las mismas condiciones que la
      // lista de Leads, no del groupBy: ese agrupa por status y no sabe
      // nada de la espera del protocolo.
      prisma.lead.count({ where: dondeRepartible(tenantId) }),
      prisma.lead.count({ where: dondeEnEspera(tenantId) }),
    ]);

    const porVendedor = {};
    for (const v of vendedores) {
      porVendedor[v.id] = {
        id: v.id, nombre: v.nombre,
        asignados: 0, pendientes: 0, concretadas: 0, rechazadas: 0, reagendadas: 0, noConcretadas: 0,
        ventasHoy: 0, comisionHoy: 0,
      };
    }

    for (const row of ventasHoy) {
      const bucket = porVendedor[row.vendedorId];
      if (bucket) {
        bucket.ventasHoy = row._sum.monto || 0;
        bucket.comisionHoy = row._sum.comision || 0;
      }
    }

    const totales = {
      asignados: 0,
      // Lo que se puede repartir ahora mismo, que es lo que la coordinadora
      // va a encontrar al entrar a Leads. Antes era "todo lo que no tiene
      // vendedora", cerrados y en espera incluidos: el tablero prometia 46
      // leads y la cola mostraba uno.
      sinAsignar: repartibles,
      enEspera,
      pendientes: 0,
      concretadas: 0,
      rechazadas: 0,
      reagendadas: 0,
      noConcretadas: 0,
    };

    // Un solo mapa en vez de la cadena de ternarios que habia: al agregar
    // un quinto estatus, el ultimo `else` lo habria contado como reagendado
    // sin que nada fallara ni avisara.
    const CAMPO = {
      pendiente: "pendientes",
      concretada: "concretadas",
      rechazada: "rechazadas",
      reagendada: "reagendadas",
      noConcretada: "noConcretadas",
    };

    for (const row of grouped) {
      const bucket = porVendedor[row.vendedorId];
      const field = CAMPO[classify(row.status)];
      // Un lead sin vendedora no esta asignado a nadie: contarlo en
      // "asignados" inflaba el tablero con la propia cola por repartir.
      // Cuantos son exactamente se cuenta aparte (`repartibles`): aqui
      // entrarian tambien los cerrados y los que aun estan en espera.
      if (row.vendedorId == null) continue;
      totales.asignados += row._count;
      totales[field] += row._count;
      if (bucket) {
        bucket.asignados += row._count;
        bucket[field] += row._count;
      }
    }

    const vendedoresConEficiencia = Object.values(porVendedor)
      .map((v) => ({ ...v, eficiencia: v.asignados > 0 ? Math.round((v.concretadas / v.asignados) * 100) : 0 }))
      .sort((a, b) => b.eficiencia - a.eficiencia);

    res.json({ totales, vendedores: vendedoresConEficiencia });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/vendedores?leadId=
//
// Las vendedoras del selector. Con `leadId`, cada una viene con lo que la
// coordinadora necesita saber ANTES de asignarle ese lead:
//
//   "Citlali Díaz — Generó la rellamada"
//   "Mariana López — Gestionó este lead hoy"
//   "Daniela Pérez — Sin gestión previa hoy"
//
// Son INDICADORES, no bloqueos: el documento es explícito en que ninguna
// vendedora se elimina del selector y la coordinadora puede elegir a
// cualquiera de las habilitadas. Lo que cambia es que ahora elige sabiendo.
// La única exclusión sigue siendo la de siempre: usuarios inactivos.
router.get("/vendedores", async (req, res) => {
  try {
    const leadId = parseInt(req.query.leadId);
    const tenantId = req.user.tenantId;

    const [vendedores, cargaHoy, lead, contexto] = await Promise.all([
      prisma.user.findMany({
        where: { rol: "VENDEDOR", activo: true, tenantId },
        select: { id: true, nombre: true },
        orderBy: { nombre: "asc" },
      }),
      asignacionesDeHoy(tenantId),
      Number.isInteger(leadId)
        ? prisma.lead.findFirst({
            where: { id: leadId, tenantId },
            select: { vendedorId: true, reagendaVendedorSugeridoId: true },
          })
        : null,
      Number.isInteger(leadId) ? contextoDeAsignacion([leadId], tenantId) : null,
    ]);

    const ctx = contexto?.get(leadId) ?? null;
    const asignadasHoy = new Set((ctx?.asignadasHoy ?? []).map((v) => v.id));

    res.json({
      vendedores: vendedores.map((v) => {
        // El orden de las etiquetas es el de su peso al decidir: quien
        // generó la rellamada ya habló con el cliente, y eso pesa más que
        // haberlo gestionado hoy.
        const generoRellamada = lead?.reagendaVendedorSugeridoId === v.id;
        const laTieneAhora = lead?.vendedorId === v.id;
        const gestionoHoy = asignadasHoy.has(v.id);
        const esUltima = ctx?.ultimaVendedora?.id === v.id;

        const nota = !lead
          ? null
          : generoRellamada
            ? "Generó la rellamada"
            : laTieneAhora
              ? "Lo tiene asignado ahora"
              : gestionoHoy
                ? "Gestionó este lead hoy"
                : esUltima
                  ? "Última vendedora que lo atendió"
                  : "Sin gestión previa hoy";

        return {
          id: v.id,
          nombre: v.nombre,
          nota,
          generoRellamada,
          gestionoHoy,
          esUltima,
          // Cuántos leads recibió hoy. Responde a algo que la coordinadora
          // hacía de memoria: repartir parejo.
          asignacionesHoy: cargaHoy.get(v.id) ?? 0,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/leads
//
// La cola de trabajo. Devuelve los leads ya clasificados en las secciones
// del protocolo (pendientes antiguos / nuevos / reintentos / rellamadas /
// en espera) y, con cada uno, lo que hace falta para decidir a quien
// darselo sin abrir nada: cuantos intentos lleva, quien lo tuvo, a quien se
// le dio hoy, cuando se desbloquea y cuanto le queda de vida.
//
// Antes era una lista plana ordenada por fecha de entrada. Con 60 leads en
// pantalla eso no es una cola: es un volcado, y la coordinadora repartia
// por el orden en que los veia.
router.get("/leads", async (req, res) => {
  try {
    const { state, productoId, search, asignacion, supervision } = req.query;
    const where = { tenantId: req.user.tenantId };

    // Los dos filtros de abajo son OR por dentro, asi que van en un AND:
    // asignarlos los dos a where.OR haria que el segundo pisara al primero.
    const filtros = [];

    // La cola de trabajo son los leads sin vendedora: con asignacion manual
    // es lo que el coordinador tiene que repartir. "asignados" y "todos"
    // quedan disponibles para consultar.
    // "pendientes" es estrictamente lo que no tiene vendedora, para que la
    // lista cuadre con el contador `sinAsignar` que va en el mismo response.
    // Un lead ya repartido se consulta y se reasigna desde "asignados".
    if (asignacion === "asignados") {
      where.vendedorId = { not: null };
    } else if (asignacion === "espera") {
      // Los que rebotaron y siguen cumpliendo su espera. Se pueden mirar --
      // y reasignar a mano si la coordinadora decide que vale la pena --
      // pero no salen en la cola normal para que el protocolo se respete
      // solo. Esconderlos del todo era peor: parecian haberse perdido.
      where.vendedorId = null;
      where.disponibleDesde = { gt: new Date() };
    } else if (asignacion === "atrasados") {
      // La pestaña de control del protocolo: lo que ya debio haberse hecho.
      // Son dos cosas distintas que se ven juntas porque las dos significan
      // lo mismo para quien reparte -- esto lleva retraso -- y ninguna de
      // las dos bloquea el lead.
      where.vendedorId = null;
      where.status = { in: LEAD_STATUSES_ABIERTOS };
      filtros.push({
        OR: [
          // Se vencieron las 72 h sin los intentos que tocaban.
          { seguimientoIncompleto: true },
          // Paso su ventana de reparto y nadie lo asigno.
          { disponibleHasta: { lt: new Date() } },
          // La hora que se le prometio al cliente ya paso.
          { status: "REAGENDADO", fechaReagenda: { lt: new Date() } },
        ],
      });
    } else if (asignacion !== "todos") {
      where.vendedorId = null;
      // Un lead que acaba de rebotar por no contestar sigue en la cola
      // pero no se reparte hasta que pase su espera: entregarlo de
      // inmediato seria marcarle tres veces en cinco minutos.
      filtros.push(filtroDisponible());
    }

    // Los que la vendedora paso a supervision: el cliente pidio algo
    // concreto y alguien tiene que decidir. Van aparte porque se pierden
    // entre los leads nuevos de la cola.
    if (supervision === "si") where.requiereSupervision = true;

    if (state) where.state = state;
    if (productoId) where.productoId = parseInt(productoId);
    if (search) {
      filtros.push({
        OR: [
          { nombre: { contains: search, mode: "insensitive" } },
          { producto: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    if (filtros.length > 0) where.AND = filtros;

    const [leads, sinAsignar, enEspera, atrasados, params] = await Promise.all([
      prisma.lead.findMany({
        where,
        // El orden fino lo pone src/lib/colaCoordinacion.js, que agrupa por
        // sección y ordena dentro de cada una. Este `orderBy` solo decide
        // QUÉ 100 leads se traen cuando hay más: los más antiguos, que son
        // los que están por perderse.
        orderBy: [{ vendedorId: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
        take: 100,
        include: {
          vendedor: { select: { id: true, nombre: true } },
          // La que atendió la llamada donde se pidió la reagenda: el
          // protocolo pide devolvérsela a ella con prioridad.
          reagendaVendedorSugerido: { select: { id: true, nombre: true } },
          // Cuantas veces se le ha marcado y cuando fue la ultima: es lo
          // que separa un lead intacto de uno que ya rebotó, y lo que deja
          // ver el ritmo del seguimiento sin abrir el historial.
          _count: { select: { llamadas: true } },
          llamadas: { orderBy: { fecha: "desc" }, take: 1, select: { fecha: true, desenlace: true, contestada: true } },
        },
      }),
      prisma.lead.count({ where: dondeRepartible(req.user.tenantId) }),
      prisma.lead.count({ where: dondeEnEspera(req.user.tenantId) }),
      // El contador de la pestaña "Atrasados". Se cuenta siempre, se esté
      // viendo o no: es la alerta que hace que alguien entre a verla.
      prisma.lead.count({
        where: {
          tenantId: req.user.tenantId,
          vendedorId: null,
          status: { in: LEAD_STATUSES_ABIERTOS },
          OR: [
            { seguimientoIncompleto: true },
            { disponibleHasta: { lt: new Date() } },
            { status: "REAGENDADO", fechaReagenda: { lt: new Date() } },
          ],
        },
      }),
      getParametros(req.user.tenantId),
    ]);

    // El semaforo y los relojes salen de src/lib/semaforoLead.js, que es
    // el mismo que usan la pantalla del admin y la de la vendedora: si
    // cada una lo calculara, el mismo lead se pintaria distinto segun
    // quien lo mire.
    const intentosPorLead = new Map(
      leads.map((l) => [l.id, { intentos: l._count.llamadas, ultimaLlamada: l.llamadas[0] ?? null }])
    );
    const descripciones = await describirLeads(leads, req.user.tenantId, intentosPorLead);

    // Quién tuvo cada lead y a quién se le dio hoy. Una sola consulta para
    // todo el lote: una por tarjeta convertiría abrir Leads en 120 viajes.
    const contexto = await contextoDeAsignacion(leads.map((l) => l.id), req.user.tenantId);

    // Un solo instante para todo el lote: calculado por lead, un lote que
    // tarde en procesarse podría partir el día a la mitad y clasificar dos
    // leads iguales en secciones distintas.
    const ahora = new Date();
    const hoy = diaLocal(ahora);

    const enriquecidos = leads.map((l, i) => {
      const { _count, llamadas, ...lead } = l;
      const intentos = _count.llamadas;
      const ctx = contexto.get(l.id) ?? { ultimaVendedora: null, asignadasHoy: [] };

      return {
        ...lead,
        ...descripciones[i],
        grupo: grupoDe(lead, { intentos, ahora, hoy }),
        // El distintivo verde. Se calcula en el servidor y no en la
        // pantalla porque depende del día de la operación (México), y el
        // navegador de quien mira puede estar en otro huso.
        esNuevo: esNuevoDeHoy(lead, intentos, hoy),
        atraso: motivoDeAtraso(lead, { ahora, alertaAtrasoMin: params.alertaAtrasoMin }),
        ultimaVendedora: ctx.ultimaVendedora,
        asignadasHoy: ctx.asignadasHoy,
      };
    });

    res.json({
      leads: enriquecidos,
      // Las secciones, en el orden del protocolo. La pantalla las dibuja
      // tal cual: si decidiera ella el orden, acabaría discrepando del
      // servidor en cuanto cambie una regla.
      grupos: agrupar(enriquecidos),
      sinAsignar,
      enEspera,
      atrasados,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/coordinador/leads/asignar
router.post("/leads/asignar", async (req, res) => {
  try {
    const { leadIds, vendedorId } = req.body;
    if (!Array.isArray(leadIds) || leadIds.length === 0 || !vendedorId) {
      return res.status(400).json({ error: "leadIds y vendedorId requeridos" });
    }

    const vendedor = await prisma.user.findFirst({
      where: { id: parseInt(vendedorId), rol: "VENDEDOR", activo: true, tenantId: req.user.tenantId },
    });
    if (!vendedor) return res.status(404).json({ error: "Vendedor no encontrado" });

    const ids = leadIds.map(Number).filter(Number.isInteger);
    const candidatos = await prisma.lead.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
      select: {
        id: true,
        nombre: true,
        status: true,
        disponibleDesde: true,
        vendedor: { select: { id: true, nombre: true } },
      },
    });
    if (candidatos.length === 0) return res.status(404).json({ error: "No se encontraron esos leads" });

    const ahora = new Date();

    // El candado del protocolo: un lead que acaba de rebotar no se puede
    // repartir hasta que pase su espera. El documento lo pide expresamente
    // ("impedir reasignación antes del horario permitido"), y la guarda
    // vive aquí porque la pantalla ya los muestra en la pestaña "En
    // espera": sin esta validación bastaba seleccionarlos ahí y asignar
    // para saltarse el intervalo que existe para no quemar al cliente.
    const bloqueados = candidatos.filter((l) => l.disponibleDesde && l.disponibleDesde > ahora);
    if (bloqueados.length > 0) {
      const primero = bloqueados[0];
      return res.status(409).json({
        error:
          bloqueados.length === 1
            ? `${primero.nombre} todavía está en espera del protocolo: se podrá repartir a partir de las ${primero.disponibleDesde.toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short", timeZone: "America/Mexico_City" })}.`
            : `${bloqueados.length} de los leads seleccionados siguen en espera del protocolo y no se pueden repartir todavía.`,
        bloqueados: bloqueados.map((l) => ({ id: l.id, nombre: l.nombre, disponibleDesde: l.disponibleDesde })),
      });
    }

    // Un lead cerrado no es trabajo de nadie: asignarlo le llenaría la
    // lista a la vendedora de leads que no puede llamar.
    const cerrados = candidatos.filter((l) => !LEAD_STATUSES_ABIERTOS.includes(l.status));
    if (cerrados.length > 0) {
      return res.status(409).json({
        error:
          cerrados.length === 1
            ? `${cerrados[0].nombre} ya está cerrado. Si fue un error, regrésalo a la cola primero.`
            : `${cerrados.length} de los leads seleccionados ya están cerrados.`,
      });
    }

    const antes = candidatos;

    // El lead y su bitácora se escriben juntos: una reasignación sin
    // registro no se puede auditar, y es justo el dato con el que la
    // coordinadora decide el siguiente reparto.
    const result = await prisma.$transaction(async (tx) => {
      const result = await tx.lead.updateMany({
        where: { id: { in: antes.map((l) => l.id) }, tenantId: req.user.tenantId },
        // Queda registrado quien repartio: es a esa coordinadora a la que se
        // le acredita la comision por la venta que salga del lead.
        data: {
          vendedorId: vendedor.id,
          asignadoPorCoordinador: true,
          asignadoPorId: req.user.id,
          // El reparto es lo que vuelve a este lead trabajo de hoy, aunque
          // haya entrado hace tres dias: sin esta marca el reporte de
          // Progreso lo seguiria contando en el dia en que llego.
          asignadoAt: ahora,
          // Repartirlo es atenderlo: la petición de supervisión queda
          // resuelta y la marca de "revisar disponibilidad" también.
          requiereSupervision: false,
          requiereRevisionHorario: false,
          // La ventana de reparto se cierra al repartir. Si se quedara
          // vencida, el lead seguiría marcado como atrasado ya en manos de
          // una vendedora.
          disponibleHasta: null,
        },
      });

      for (const lead of antes) {
        await registrarAsignacion(tx, {
          leadId: lead.id,
          tenantId: req.user.tenantId,
          actor: { id: req.user.id, nombre: req.user.nombre },
          anterior: lead.vendedor,
          nuevo: { id: vendedor.id, nombre: vendedor.nombre },
          evento: lead.vendedor ? "reasignada" : "asignada",
        });
      }

      return result;
    });

    // El kardex necesita saber a quien se le quito el lead, no solo a quien
    // se le dio: una reasignacion sin el "antes" no se puede auditar.
    detallarMovimiento(req, {
      entidadId: antes.length === 1 ? antes[0].id : null,
      descripcion:
        antes.length === 1
          ? `Asignó el lead ${antes[0].nombre} a ${vendedor.nombre}`
          : `Asignó ${antes.length} leads a ${vendedor.nombre}`,
      antes: {
        leads: antes.map((l) => ({ id: l.id, nombre: l.nombre, vendedor: l.vendedor?.nombre ?? "sin asignar" })),
      },
      despues: { vendedor: vendedor.nombre, leads: antes.map((l) => l.id) },
    });

    // La vendedora se entera de que le cayó trabajo sin tener que recargar
    // la cola. Un aviso por lead cuando son pocos; uno solo cuando es un
    // lote, para no llenarle la campana de veinte líneas iguales.
    if (antes.length <= 3) {
      crearAvisos(
        antes.map((l) => ({
          userId: vendedor.id,
          tenantId: req.user.tenantId,
          tipo: "lead.asignado",
          categoria: "INFO",
          titulo: "Nuevo lead asignado",
          mensaje: `${l.nombre} está en tu cola, asignado por ${req.user.nombre}.`,
          enlace: "/leads",
        })),
      );
    } else {
      crearAviso({
        userId: vendedor.id,
        tenantId: req.user.tenantId,
        tipo: "lead.asignado",
        categoria: "INFO",
        titulo: `${antes.length} leads nuevos en tu cola`,
        mensaje: `${req.user.nombre} te asignó ${antes.length} leads. Empieza por los más recientes.`,
        enlace: "/leads",
      });
    }

    const sinAsignar = await prisma.lead.count({
      where: { tenantId: req.user.tenantId, vendedorId: null },
    });

    emitir(req.user.tenantId, "leads.asignados", { total: result.count, vendedor: vendedor.nombre });
    res.json({ message: "Leads asignados", actualizados: result.count, sinAsignar });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/progreso?fecha=  |  ?desde=&hasta=
//
// Un dia, una semana o un rango. `fecha` se conserva porque es lo que
// pedia la pantalla antes; `desde`/`hasta` es lo general y un solo dia es
// el caso de desde == hasta.
router.get("/progreso", async (req, res) => {
  try {
    // Las fechas que llegan ("2026-10-26") son dias del calendario de quien
    // las escribe, no instantes UTC: sin esto el corte perdia todo lo
    // ocurrido despues de las 18:00 (ver src/lib/fechasLocales.js).
    const { fecha, desde, hasta } = req.query;
    const inicio = desde ? inicioDeDia(desde) : fecha ? inicioDeDia(fecha) : inicioDeHoy();
    const fin = hasta
      ? finDeDia(hasta)
      : desde
        ? finDeDia(desde)
        : new Date(inicio.getTime() + 86400000);

    if (!inicio || !fin || fin < inicio) {
      return res.status(400).json({ error: "Rango de fechas invalido" });
    }

    const tenantId = req.user.tenantId;

    // El dia de trabajo no son solo los leads que entraron hoy: tambien los
    // que hoy se repartieron, aunque hayan llegado hace una semana. Cuando
    // esto miraba solo createdAt, la coordinadora asignaba 25 leads
    // reasignados a una vendedora y la fila seguia en cero.
    const enRango = { gte: inicio, lte: fin };
    const [leads, vendedoras] = await Promise.all([
      prisma.lead.findMany({
        where: {
          tenantId,
          OR: [{ createdAt: enRango }, { asignadoAt: enRango }],
        },
        orderBy: { createdAt: "desc" },
        include: {
          vendedor: { select: { id: true, nombre: true } },
          items: { include: { producto: { select: { nombre: true } } } },
          venta: { select: { monto: true } },
        },
      }),
      prisma.user.findMany({
        where: { tenantId, rol: "VENDEDOR", activo: true },
        select: { id: true, nombre: true },
      }),
    ]);

    // Intentos de llamada de esos leads. Es lo que separa "nadie le ha
    // marcado" de "le marcaron y no contesta": sin este dato la pantalla
    // no puede decir que es lo que de verdad necesita atencion.
    const intentos = leads.length
      ? await prisma.llamada.groupBy({
          by: ["leadId"],
          where: { tenantId, leadId: { in: leads.map((l) => l.id) } },
          _count: true,
        })
      : [];
    const intentosPorLead = Object.fromEntries(intentos.map((i) => [i.leadId, i._count]));

    const ahora = new Date();

    // Un lead que entro antes del rango y se repartio dentro de el es
    // trabajo del dia en que se repartio: ahi es donde tiene que contar.
    const dentro = (f) => f && f >= inicio && f <= fin;
    const esReasignado = (lead) => dentro(lead.asignadoAt) && !dentro(lead.createdAt);
    const fechaDelCorte = (lead) => (esReasignado(lead) ? lead.asignadoAt : lead.createdAt);

    // Corte del dia: lo que la coordinadora quiere saber de un vistazo.
    const resumen = {
      total: leads.length,
      reasignados: 0,
      sinAsignar: 0,
      sinIntentos: 0,
      nuevos: 0,
      reagendados: 0,
      concretados: 0,
      descartados: 0,
      noConcretados: 0,
      // Los que vencieron el plazo sin los intentos que tocaban: siguen
      // abiertos y son lo primero que la coordinadora tiene que repartir.
      seguimientoIncompleto: 0,
      monto: 0,
    };

    // Reagendados cuya hora ya paso: son los que se van a perder si nadie
    // los retoma hoy, y hoy no aparecian en ningun lado.
    const vencidos = [];

    const porVendedora = Object.fromEntries(
      vendedoras.map((v) => [v.id, {
        id: v.id, nombre: v.nombre,
        asignados: 0, reasignados: 0, sinIntentos: 0, concretados: 0, descartados: 0, abiertos: 0, monto: 0,
      }])
    );

    for (const lead of leads) {
      const n = intentosPorLead[lead.id] ?? 0;
      const reasignado = esReasignado(lead);
      if (n === 0) resumen.sinIntentos += 1;
      if (!lead.vendedorId) resumen.sinAsignar += 1;
      if (reasignado) resumen.reasignados += 1;

      if (lead.status === "NUEVO") resumen.nuevos += 1;
      else if (lead.status === "REAGENDADO") resumen.reagendados += 1;
      else if (lead.status === "VENTA") resumen.concretados += 1;
      else if (lead.status === "DESCARTADO") resumen.descartados += 1;
      else if (lead.status === "NO_CONCRETADO") resumen.noConcretados += 1;

      if (lead.seguimientoIncompleto) resumen.seguimientoIncompleto += 1;

      const monto = lead.venta?.monto ?? 0;
      resumen.monto += monto;

      if (lead.status === "REAGENDADO" && lead.fechaReagenda && new Date(lead.fechaReagenda) < ahora) {
        vencidos.push(lead.id);
      }

      const b = porVendedora[lead.vendedorId];
      if (b) {
        b.asignados += 1;
        if (reasignado) b.reasignados += 1;
        if (n === 0) b.sinIntentos += 1;
        if (lead.status === "VENTA") { b.concretados += 1; b.monto += monto; }
        // Los dos cierres sin venta cuentan igual para la vendedora: en los
        // dos el lead salio de su lista sin venta. Si NO_CONCRETADO cayera
        // en `abiertos`, su columna de pendientes incluiria leads cerrados.
        else if (lead.status === "DESCARTADO" || lead.status === "NO_CONCRETADO") b.descartados += 1;
        else b.abiertos += 1;
      }
    }

    // Corte dia por dia. Con un solo dia no aporta nada y se omite; con una
    // semana o un rango es justo la pregunta ("¿que dia se cayo?").
    const porDia = new Map();
    for (const lead of leads) {
      const dia = diaLocal(fechaDelCorte(lead));
      if (!porDia.has(dia)) porDia.set(dia, { dia, total: 0, concretados: 0, descartados: 0, monto: 0 });
      const d = porDia.get(dia);
      d.total += 1;
      if (lead.status === "VENTA") { d.concretados += 1; d.monto += lead.venta?.monto ?? 0; }
      else if (lead.status === "DESCARTADO" || lead.status === "NO_CONCRETADO") d.descartados += 1;
    }
    const serie = Array.from(porDia.values()).sort((a, b) => a.dia.localeCompare(b.dia));

    const equipo = Object.values(porVendedora)
      .map((v) => ({ ...v, conversion: v.asignados > 0 ? Math.round((v.concretados / v.asignados) * 100) : 0 }))
      .sort((a, b) => b.concretados - a.concretados || b.asignados - a.asignados);

    res.json({
      fecha: inicio,
      desde: inicio,
      hasta: fin,
      dias: serie.length,
      total: leads.length,
      resumen,
      serie,
      equipo,
      leads: leads.map((l) => ({
        ...l,
        intentos: intentosPorLead[l.id] ?? 0,
        reagendaVencida: vencidos.includes(l.id),
        // Para que la lista pueda explicar por que un lead de otro dia
        // aparece en el corte de hoy.
        reasignado: esReasignado(l),
        monto: l.venta?.monto ?? null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

function buildHistorialWhere(req) {
  const { from, to, vendedorId, estado, search } = req.query;
  const where = { tenantId: req.user.tenantId };

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(`${from}T00:00:00`);
    if (to) where.createdAt.lte = new Date(`${to}T23:59:59`);
  }
  if (vendedorId) where.vendedorId = parseInt(vendedorId);
  if (estado && estado !== "TODOS" && STATUS_GROUPS[estado]) {
    where.status = { in: STATUS_GROUPS[estado] };
  }
  if (search) {
    where.OR = [
      { nombre: { contains: search, mode: "insensitive" } },
      { producto: { contains: search, mode: "insensitive" } },
      { telefono: { contains: search, mode: "insensitive" } },
      { folioPS: { contains: search, mode: "insensitive" } },
    ];
  }
  return where;
}

// GET /api/coordinador/historial
router.get("/historial", async (req, res) => {
  try {
    const where = buildHistorialWhere(req);
    const take = Math.min(parseInt(req.query.take) || 50, 200);
    const skip = parseInt(req.query.skip) || 0;

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { vendedor: { select: { id: true, nombre: true } } },
      }),
      prisma.lead.count({ where }),
    ]);

    res.json({ leads, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/historial/export
router.get("/historial/export", async (req, res) => {
  try {
    const where = buildHistorialWhere(req);
    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 5000,
      include: {
        vendedor: { select: { nombre: true } },
        // El folio y el estado del envio viven en la venta, no en el lead:
        // sin esto el reporte no servia para dar seguimiento al cierre.
        venta: {
          select: {
            folio: true, monto: true, comision: true, costoEnvio: true, fecha: true,
            entregaExitosa: true, fullvectorOrderId: true, fullvectorSinCobertura: true,
            fullvectorSyncStatus: true,
          },
        },
        llamadas: { select: { fecha: true }, orderBy: { fecha: "asc" }, take: 1 },
        _count: { select: { llamadas: true } },
      },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "PerfectSelft";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Historial", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    sheet.columns = [
      { header: "Folio", key: "folio", width: 16 },
      { header: "Estatus", key: "estatus", width: 13 },
      { header: "Fecha del lead", key: "fecha", width: 18 },
      { header: "Fecha de venta", key: "fechaVenta", width: 18 },
      { header: "Vendedora", key: "vendedor", width: 26 },
      { header: "Cliente", key: "cliente", width: 26 },
      { header: "Telefono", key: "telefono", width: 16 },
      { header: "Producto", key: "producto", width: 24 },
      { header: "Monto", key: "monto", width: 13 },
      { header: "Envio", key: "envio", width: 11 },
      { header: "Total cobrado", key: "total", width: 14 },
      { header: "Comision", key: "comision", width: 12 },
      { header: "Calle", key: "calle", width: 26 },
      { header: "Numero", key: "numero", width: 10 },
      { header: "Colonia", key: "colonia", width: 22 },
      { header: "Municipio", key: "municipio", width: 20 },
      { header: "Estado", key: "estado", width: 18 },
      { header: "CP", key: "cp", width: 9 },
      { header: "Referencias", key: "referencias", width: 42 },
      { header: "Entrega", key: "entrega", width: 16 },
      { header: "ID FullVector", key: "fullvector", width: 28 },
      { header: "Llamadas", key: "llamadas", width: 10 },
      { header: "1a llamada", key: "primeraLlamada", width: 18 },
    ];

    const COLOR_ESTATUS = {
      concretada: "FF1B9247",
      rechazada: "FFC0392B",
      // Mas apagado que el rechazo: no es un cliente que dijo que no, es un
      // lead que se quedo sin tiempo. Verlos del mismo rojo en el reporte
      // haria creer que la base es peor de lo que es.
      noConcretada: "FF9A6A2F",
      reagendada: "FFB8860B",
      pendiente: "FF6B7280",
    };

    for (const lead of leads) {
      const v = lead.venta;
      const estatus = classify(lead.status);
      const fila = sheet.addRow({
        folio: v?.folio || lead.folio || "",
        estatus,
        fecha: lead.createdAt,
        fechaVenta: v?.fecha || "",
        vendedor: lead.vendedor?.nombre || "Sin asignar",
        cliente: lead.nombre,
        telefono: lead.telefono,
        producto: lead.producto,
        monto: v?.monto ?? lead.monto ?? "",
        envio: v?.costoEnvio ?? "",
        total: v ? v.monto + (v.costoEnvio || 0) : "",
        comision: v?.comision ?? "",
        calle: lead.shippingStreet || "",
        numero: lead.shippingNumber || "",
        colonia: lead.colonia || "",
        municipio: lead.municipio || "",
        estado: lead.state || "",
        cp: lead.zipCode || "",
        referencias: lead.shippingReferences || "",
        entrega: !v
          ? ""
          : v.fullvectorSyncStatus !== "SYNCED"
            ? "No llego a FullVector"
            : v.fullvectorSinCobertura
              ? "Prepago (sin COD)"
              : v.entregaExitosa
                ? "Entregada"
                : "En transito",
        fullvector: v?.fullvectorOrderId || "",
        llamadas: lead._count.llamadas,
        primeraLlamada: lead.llamadas[0]?.fecha || "",
      });

      fila.getCell("estatus").font = { bold: true, color: { argb: COLOR_ESTATUS[estatus] } };
      for (const key of ["monto", "envio", "total", "comision"]) {
        fila.getCell(key).numFmt = '"$"#,##0.00';
      }
      for (const key of ["fecha", "fechaVenta", "primeraLlamada"]) {
        fila.getCell(key).numFmt = "dd/mm/yyyy hh:mm";
      }
      fila.getCell("referencias").alignment = { wrapText: true, vertical: "top" };
      // El CP como texto: Excel se come el cero inicial de los CP que
      // empiezan con 0 y deja de cuadrar con el catalogo.
      fila.getCell("cp").numFmt = "@";
      // Una venta que no llego a la mensajeria se tiene que ver de lejos.
      if (v && v.fullvectorSyncStatus !== "SYNCED") {
        fila.getCell("entrega").font = { bold: true, color: { argb: "FFC0392B" } };
      }
    }

    const encabezado = sheet.getRow(1);
    encabezado.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    encabezado.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7E5A97" } };
    encabezado.alignment = { vertical: "middle", horizontal: "left" };
    encabezado.height = 22;

    // Zebra: con 20+ columnas, seguir un renglon con la vista se vuelve dificil.
    for (let i = 2; i <= sheet.rowCount; i++) {
      if (i % 2 === 0) {
        sheet.getRow(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F4F8" } };
      }
    }

    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="historial.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/coordinador/leads/:id/reactivar
//
// Regresa a la cola de asignacion un lead descartado. Hasta ahora un
// DESCARTADO era callejon sin salida: /api/leads/:id/devolver lo rechaza a
// proposito (no es trabajo pendiente de nadie) y la cola solo mira los leads
// sin vendedora, asi que un descarte por error se perdia para siempre.
router.post("/leads/:id/reactivar", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const motivo = typeof req.body?.motivo === "string" ? req.body.motivo.trim().slice(0, 300) : "";

    const lead = await prisma.lead.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!lead) return res.status(404).json({ error: "Lead no encontrado" });
    if (lead.status === "VENTA") {
      return res.status(409).json({ error: "Este lead ya tiene una venta cerrada" });
    }
    // Los dos cierres sin venta se pueden rehabilitar. NO_CONCRETADO es el
    // caso mas frecuente: el lead era bueno y se le acabo el plazo, y la
    // coordinadora decide que vale la pena un intento mas.
    if (!["DESCARTADO", "NO_CONCRETADO"].includes(lead.status)) {
      return res.status(409).json({ error: "Este lead no esta cerrado" });
    }

    const actualizado = await prisma.lead.update({
      where: { id },
      data: {
        status: "NUEVO",
        vendedorId: null,
        asignadoAt: null,
        asignadoPorCoordinador: false,
        // Sin esto el lead vuelve a la cola arrastrando el motivo con que
        // se cerro, y el tablero de calidad lo sigue contando como basura.
        motivoDescarte: null,
        motivoDescarteNota: null,
        descartadoAt: null,
        descartadoPorId: null,
        seguimientoIncompleto: false,
        seguimientoIncompletoAt: null,
        // El protocolo empieza de cero: contando desde su primera llamada
        // historica, ya habria agotado las 72 horas y se cerraria solo en
        // el primer intento.
        reintentosDesde: new Date(),
        disponibleDesde: null,
        disponibleHasta: null,
        devueltoAt: new Date(),
        devueltoMotivo: motivo || "Descartado por error, reactivado para volver a llamar",
        devueltoPorNombre: req.user.nombre,
      },
    });

    detallarMovimiento(req, {
      entidadId: id,
      descripcion: `Reactivo el lead cerrado ${lead.nombre}`,
      antes: { status: lead.status, motivo: lead.motivoDescarte, vendedor: lead.vendedorId },
      despues: { status: "NUEVO", vendedor: "sin asignar", motivo: actualizado.devueltoMotivo },
    });

    res.json({ message: "Lead regresado a la cola de asignacion", leadId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/coordinador/comisiones?fecha=YYYY-MM-DD
//
// Corte de comisiones de la quincena que contiene `fecha` (hoy si no se
// manda): por vendedora, piezas acumuladas y bloques pagados; y la tarifa
// por venta de cada coordinadora. Es la vista con la que se arma la nomina.
router.get("/comisiones", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const fecha = req.query.fecha ? new Date(`${req.query.fecha}T12:00:00`) : new Date();
    if (Number.isNaN(fecha.getTime())) return res.status(400).json({ error: "fecha invalida" });

    const params = await getParametros(tenantId);
    const vendedoras = await prisma.user.findMany({
      where: { tenantId, rol: "VENDEDOR" },
      select: { id: true, nombre: true, activo: true },
      orderBy: { nombre: "asc" },
    });

    const porVendedora = [];
    for (const v of vendedoras) {
      const q = await calcularQuincenaVendedora(tenantId, v.id, fecha, params);
      // Una vendedora sin movimiento en la quincena no ensucia el corte.
      if (q.ventas.length === 0) continue;
      porVendedora.push({
        id: v.id,
        nombre: v.nombre,
        activo: v.activo,
        piezas: q.piezas,
        bloques: q.bloques,
        sobrantes: q.sobrantes,
        comision: q.comision,
        piezasSinConfirmar: q.ventas.filter((d) => !d.cuenta).reduce((s, d) => s + d.piezas, 0),
        ventas: q.ventas,
      });
    }

    const coordinacion = await calcularQuincenaCoordinadoras(tenantId, fecha, params);

    res.json({
      quincena: coordinacion.quincena,
      reglas: {
        porBloque: params.comisionBloquePiezas,
        importeBloque: params.comisionBloqueMonto,
        tarifaCoordinadora: params.comisionCoordinadoraPorVenta,
        metaDiariaUnidades: params.metaDiariaUnidades,
      },
      vendedoras: porVendedora.sort((a, b) => b.comision - a.comision || b.piezas - a.piezas),
      totalVendedoras: porVendedora.reduce((s, v) => s + v.comision, 0),
      coordinacion,
      totalGeneral: porVendedora.reduce((s, v) => s + v.comision, 0) + coordinacion.total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
