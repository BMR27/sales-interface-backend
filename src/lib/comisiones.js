// Comisiones por bloque de piezas (especificación de reglas R01-R12).
//
// La comisión de la vendedora dejó de ser un porcentaje de cada venta: ahora
// se paga por bloques de piezas pagadas acumuladas en la quincena.
//
//   R01/R02  cada bloque de 3 piezas pagadas = $40
//   R03      en el 3+1, la pieza de regalo no cuenta
//   R04      las piezas suman aunque sean tickets o clientes distintos
//   R05      la ventana de acumulación es la quincena
//   R06      la comisión sólo sube al completar bloque: en 4 y 5 piezas el
//            importe nuevo es $0; en 6 vuelve a ser $40
//   R07      total = ENTERO(piezas netas / 3) x $40
//   R08      cancelaciones y devoluciones restan piezas y se recalcula
//   R09      cada quincena arranca de cero
//   R10      la meta diaria es indicador, no condiciona el pago
//   R12      una pieza se comisiona una sola vez (de ahí el recálculo
//            completo de la quincena en vez de ir sumando a mano)
//
// La coordinadora cobra una tarifa fija por venta válida, no por pieza.
const { PrismaClient } = require("@prisma/client");
const { getParametros } = require("./parametros");

const prisma = new PrismaClient();

// --- Quincenas: del 1 al 15 y del 16 al último día del mes ---

function quincenaDe(fecha) {
  const d = new Date(fecha);
  const año = d.getFullYear();
  const mes = d.getMonth();
  const primera = d.getDate() <= 15;

  const inicio = new Date(año, mes, primera ? 1 : 16, 0, 0, 0, 0);
  // El día 0 del mes siguiente es el último del actual: evita la tabla de
  // días por mes y los años bisiestos.
  const fin = primera
    ? new Date(año, mes, 15, 23, 59, 59, 999)
    : new Date(año, mes + 1, 0, 23, 59, 59, 999);

  return {
    inicio,
    fin,
    clave: `${año}-${String(mes + 1).padStart(2, "0")}-${primera ? "Q1" : "Q2"}`,
    etiqueta: `${primera ? "1 al 15" : "16 al " + fin.getDate()} de ${inicio.toLocaleDateString("es-MX", { month: "long", year: "numeric" })}`,
  };
}

// --- Piezas de una venta ---

// Sólo las pagadas: la pieza de regalo del 3+1 no genera comisión (R03).
// Sin LeadItem se cae a lead.cantidad, el mismo criterio que usa
// ganancias.js para descontar inventario.
function piezasPagadas(venta) {
  const items = venta.lead?.items || [];
  if (items.length > 0) {
    return items.filter((i) => !i.esRegalo).reduce((s, i) => s + i.cantidad, 0);
  }
  return venta.lead?.cantidad || 1;
}

// Una venta sólo entra al acumulado cuando la entrega está confirmada y no
// está cancelada. Mientras tanto la pieza existe pero no se paga.
function cuentaParaComision(venta) {
  return venta.entregaExitosa === true && venta.cancelada !== true;
}

const INCLUDE_PIEZAS = { lead: { select: { cantidad: true, items: { select: { cantidad: true, esRegalo: true } } } } };

// --- Cálculo de la quincena de una vendedora ---

// Devuelve el desglose y, de paso, el reparto de la comisión venta por venta:
// a cada una se le atribuye lo que hizo subir el total al momento de entrar
// (la columna "Comisión nueva" de la especificación). Así la suma de las
// comisiones por venta sigue siendo el total de la quincena.
async function calcularQuincenaVendedora(tenantId, vendedorId, fechaRef, params) {
  const { inicio, fin, clave, etiqueta } = quincenaDe(fechaRef);
  const p = params || (await getParametros(tenantId));
  const porBloque = p.comisionBloquePiezas;
  const importe = p.comisionBloqueMonto;

  const ventas = await prisma.venta.findMany({
    where: { tenantId, vendedorId, fecha: { gte: inicio, lte: fin } },
    orderBy: [{ fecha: "asc" }, { id: "asc" }],
    include: INCLUDE_PIEZAS,
  });

  let acumuladas = 0;
  let pagado = 0;
  const detalle = [];

  for (const venta of ventas) {
    const piezas = piezasPagadas(venta);
    const valida = cuentaParaComision(venta);

    if (valida) acumuladas += piezas;
    const totalHastaAqui = Math.floor(acumuladas / porBloque) * importe;
    const nueva = totalHastaAqui - pagado;
    pagado = totalHastaAqui;

    detalle.push({
      ventaId: venta.id,
      folio: venta.folio,
      fecha: venta.fecha,
      piezas,
      cuenta: valida,
      motivoNoCuenta: valida
        ? null
        : venta.cancelada
          ? "Cancelada o devuelta"
          : "Entrega sin confirmar",
      acumuladas,
      comisionNueva: nueva,
      comisionAcumulada: pagado,
    });
  }

  return {
    quincena: { clave, etiqueta, inicio, fin },
    piezas: acumuladas,
    bloques: Math.floor(acumuladas / porBloque),
    // Lo que falta para que la siguiente pieza cierre bloque y pague.
    sobrantes: acumuladas % porBloque,
    comision: pagado,
    porBloque,
    importeBloque: importe,
    ventas: detalle,
  };
}

// Reescribe `Venta.comision` de toda la quincena de esa vendedora. Se corre
// cada vez que algo puede mover el acumulado (una venta nueva, una entrega
// confirmada, una cancelación): recalcular el periodo completo es lo que
// garantiza R12, que ninguna pieza se pague dos veces.
async function recalcularQuincena(tenantId, vendedorId, fechaRef) {
  const resultado = await calcularQuincenaVendedora(tenantId, vendedorId, fechaRef);

  await prisma.$transaction(
    resultado.ventas
      // Sólo se escribe lo que cambia: evita 50 updates para corregir una.
      .filter((d) => d.comisionNueva !== undefined)
      .map((d) =>
        prisma.venta.update({ where: { id: d.ventaId }, data: { comision: d.comisionNueva } }),
      ),
  );

  return resultado;
}

// --- Coordinadoras ---

// Tarifa fija por venta válida, sin importar cuántas piezas lleve. El crédito
// va a la coordinadora que repartió ese lead; cuando lo asignó el reparto
// automático no hay a quién atribuirlo y se reparte en partes iguales entre
// las coordinadoras activas, para que el total siga cuadrando.
async function calcularQuincenaCoordinadoras(tenantId, fechaRef, params) {
  const { inicio, fin, clave, etiqueta } = quincenaDe(fechaRef);
  const p = params || (await getParametros(tenantId));
  const tarifa = p.comisionCoordinadoraPorVenta;

  const [ventas, coordinadoras] = await Promise.all([
    prisma.venta.findMany({
      where: { tenantId, fecha: { gte: inicio, lte: fin } },
      include: { lead: { select: { asignadoPorId: true } } },
    }),
    prisma.user.findMany({
      where: { tenantId, rol: "COORDINADOR", activo: true },
      select: { id: true, nombre: true },
      orderBy: { nombre: "asc" },
    }),
  ]);

  const validas = ventas.filter(cuentaParaComision);
  const porId = new Map(coordinadoras.map((c) => [c.id, { ...c, ventas: 0, comision: 0 }]));

  let sinAtribuir = 0;
  for (const v of validas) {
    const asignadora = v.lead?.asignadoPorId;
    if (asignadora && porId.has(asignadora)) {
      const c = porId.get(asignadora);
      c.ventas += 1;
      c.comision += tarifa;
    } else {
      sinAtribuir += 1;
    }
  }

  // El remanente sin dueño se divide en partes iguales. Con una sola
  // coordinadora esto equivale a darle todo, que es el caso de hoy.
  if (sinAtribuir > 0 && coordinadoras.length > 0) {
    const porCabeza = (sinAtribuir * tarifa) / coordinadoras.length;
    const ventasPorCabeza = sinAtribuir / coordinadoras.length;
    for (const c of porId.values()) {
      c.comision += porCabeza;
      c.ventasCompartidas = ventasPorCabeza;
    }
  }

  return {
    quincena: { clave, etiqueta, inicio, fin },
    tarifa,
    ventasValidas: validas.length,
    ventasTotales: ventas.length,
    ventasSinAtribuir: sinAtribuir,
    total: validas.length * tarifa,
    coordinadoras: Array.from(porId.values()).map((c) => ({
      ...c,
      comision: Math.round(c.comision * 100) / 100,
    })),
  };
}

module.exports = {
  quincenaDe,
  piezasPagadas,
  cuentaParaComision,
  calcularQuincenaVendedora,
  calcularQuincenaCoordinadoras,
  recalcularQuincena,
};
