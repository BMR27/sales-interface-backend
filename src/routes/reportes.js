// Reportes por periodo, en Excel, para administracion.
//
// Lo que resuelve: el tablero de Admin contesta "como vamos" en vivo, pero
// no sirve para sentarse a revisar un mes cerrado, ni para mandarle al
// proveedor el detalle de por que se cayeron sus leads. Eso se hacia
// pidiendo consultas a mano a la base.
//
// Son cinco hojas en un solo archivo, porque las preguntas vienen juntas:
//
//   Resumen       los numeros del periodo, cada uno con su definicion al
//                 lado -- sin eso, dos personas leen la misma celda de
//                 forma distinta
//   Leads         una fila por lead con todo lo que se sabe de el
//   Motivos       por que se cayeron, agregado, separando culpa del
//                 proveedor de trabajo comercial
//   Ventas        las concretadas, con su dinero y su entrega
//   Vendedoras    productividad por persona
//
// CADA HOJA USA SU PROPIA FECHA. Los leads se cuentan por cuando entraron,
// las ventas por cuando se vendieron y los descartes por cuando se
// descartaron. Es deliberado: asi cada hoja responde "que paso en este
// mes" y cuadra con el corte de caja y con las demas pantallas. La
// consecuencia a tener presente es que las ventas de la hoja de Ventas no
// son necesariamente de los leads de la hoja de Leads -- un lead de marzo
// pudo cerrarse en abril. Donde eso importa, la hoja de Resumen lo dice en
// la columna "Como se mide" en vez de dejarlo a la interpretacion.
const express = require("express");
const ExcelJS = require("exceljs");
const authMiddleware = require("../middleware/auth");
const gestionAdmin = require("../middleware/gestionAdmin");
const { LEAD_STATUS_LABELS, LEAD_STATUSES } = require("../lib/leadStatus");
const { POR_CLAVE: MOTIVO_POR_CLAVE, motivoLabel } = require("../lib/motivosDescarte");
const { POR_CLAVE: RESULTADO_POR_CLAVE } = require("../lib/resultadosLlamada");
const { inicioDeDia, finDeDia, diaLocal } = require("../lib/fechasLocales");
const {
  MORADO, VERDE, ROJO,
  FMT_DINERO, FMT_FECHA, FMT_PCT,
  rematar, formato, envolver, si, direccionCompleta, estadoEntrega, colorEstatus,
} = require("../lib/excelEstilo");

const router = express.Router();
const prisma = require("../lib/prisma");

// Mismo criterio que Leads y Ventas: lo ve el ADMIN y el administrador de
// operacion. No lleva datos de acceso de nadie, que es lo que obliga a
// Kardex y Equipo a ser solo del ADMIN.
router.use(authMiddleware, gestionAdmin);

// Un año es el tope. No es una limitacion tecnica sino un freno: pedir
// "todo" trae decenas de miles de filas, tarda, y nadie lee un Excel asi.
// Para una serie historica se bajan varios periodos.
const MAX_DIAS = 366;

// Tope de filas de detalle. Por encima de esto el archivo deja de abrirse
// comodo y conviene acotar el periodo; se avisa en la hoja en vez de
// truncar en silencio, que seria mentir con datos incompletos.
const MAX_DETALLE = 50000;

// --- Hoja 1: Resumen ------------------------------------------------
//
// Tres columnas y no un tablero de celdas sueltas: cada indicador trae al
// lado COMO se mide. Es la hoja que se manda por correo, y la que mas se
// malinterpreta si el numero va solo ("¿concretadas de que leads?").
function hojaResumen(wb, { desde, hasta, leads, ventas, llamadas, descartes }) {
  const sheet = wb.addWorksheet("Resumen");
  sheet.columns = [
    { header: "Indicador", key: "indicador", width: 38 },
    { header: "Valor", key: "valor", width: 16 },
    { header: "Cómo se mide", key: "nota", width: 72 },
  ];

  const filas = [];
  const agregar = (indicador, valor, nota, opts = {}) =>
    filas.push({ indicador, valor, nota, ...opts });

  // El dia se saca en el huso de la operacion, no en UTC: el fin del
  // periodo es las 23:59 locales, que en UTC ya cayo al dia siguiente, y
  // el encabezado anunciaba un dia de mas ("al 01/01/2027").
  const fmtDia = (d) => diaLocal(d).split("-").reverse().join("/");

  agregar("Periodo", `${fmtDia(desde)} al ${fmtDia(hasta)}`, "Días completos, en horario de la operación.");
  agregar("", "", "");

  // --- Leads que entraron (cohorte del periodo) ---
  agregar("LEADS QUE ENTRARON", "", "", { seccion: true });
  agregar("Total de leads", leads.length, "Leads cuya fecha de entrada cae en el periodo.");

  const porStatus = {};
  for (const l of leads) porStatus[l.status] = (porStatus[l.status] || 0) + 1;
  for (const st of LEAD_STATUSES) {
    agregar(
      `  ${LEAD_STATUS_LABELS[st]}`,
      porStatus[st] || 0,
      "Estado en que están HOY esos leads, no en el que estaban al cerrar el periodo."
    );
  }

  // Tasa de cierre de la cohorte: de los que entraron, cuantos ya son
  // venta. Es la unica tasa honesta -- dividir ventas del periodo entre
  // leads del periodo mezcla dos poblaciones distintas.
  const cerradosCohorte = leads.filter((l) => l.status === "VENTA").length;
  agregar(
    "Tasa de cierre de esta base",
    leads.length ? cerradosCohorte / leads.length : 0,
    "De los leads que entraron en el periodo, los que YA se concretaron (aunque la venta haya caído después). Es la cifra para evaluar al proveedor.",
    { pct: true }
  );

  agregar("", "", "");

  // --- Ventas del periodo (corte de caja) ---
  agregar("CONCRETADAS", "", "", { seccion: true });
  const vivas = ventas.filter((v) => !v.cancelada);
  const monto = vivas.reduce((a, v) => a + v.monto, 0);
  const envio = vivas.reduce((a, v) => a + (v.costoEnvio || 0), 0);
  const comision = vivas.reduce((a, v) => a + (v.comision || 0), 0);

  agregar("Ventas concretadas", vivas.length, "Ventas cuya FECHA DE VENTA cae en el periodo. Pueden venir de leads que entraron antes.");
  agregar("Ventas canceladas", ventas.length - vivas.length, "Canceladas o devueltas. No suman al monto.");
  agregar("Monto de producto", monto, "Sin el envío. Es la base sobre la que se paga comisión.", { dinero: true });
  agregar("Costo de envío cobrado", envio, "Flete cobrado al cliente.", { dinero: true });
  agregar("Total cobrado", monto + envio, "Producto más envío. Es lo que se le cobra al cliente.", { dinero: true });
  agregar("Comisiones generadas", comision, "Devengadas por estas ventas; el pago depende de la entrega confirmada.", { dinero: true });
  agregar("Ticket promedio", vivas.length ? monto / vivas.length : 0, "Monto de producto entre ventas no canceladas.", { dinero: true });
  agregar("Entregas confirmadas", vivas.filter((v) => v.entregaExitosa).length, "Alguien confirmó la entrega. Es la condición para pagar comisión.");
  agregar("Prepago (sin COD)", vivas.filter((v) => v.fullvectorSinCobertura).length, "El CP está fuera de la cobertura con pago contra entrega: se cobran por transferencia.");
  agregar("No llegaron a FullVector", vivas.filter((v) => v.fullvectorSyncStatus !== "SYNCED").length, "La orden no se sincronizó con la mensajería. Requieren revisión manual.", { alerta: true });

  agregar("", "", "");

  // --- Descartes del periodo ---
  agregar("LEADS CAÍDOS", "", "", { seccion: true });
  agregar("Descartados en el periodo", descartes.length, "Leads cuya FECHA DE DESCARTE cae en el periodo, sin importar cuándo entraron.");

  const culpaProveedor = descartes.filter((d) => MOTIVO_POR_CLAVE[d.motivoDescarte]?.culpaDelProveedor).length;
  const automaticos = descartes.filter((d) => MOTIVO_POR_CLAVE[d.motivoDescarte]?.automatico).length;
  agregar(
    "  Culpa del proveedor",
    culpaProveedor,
    "El lead nunca sirvió: número inexistente, equivocado, duplicado, nunca contestó. Es lo que se le reclama al proveedor."
  );
  agregar(
    "  No se cerró la venta",
    descartes.length - culpaProveedor,
    "El lead era real y contestó, pero no compró. Es trabajo comercial, no una falla de la base."
  );
  agregar(
    "% de la base que no sirvió",
    descartes.length ? culpaProveedor / descartes.length : 0,
    "Culpa del proveedor entre el total de descartes del periodo.",
    { pct: true }
  );
  agregar(
    "  Los puso el protocolo de 72h",
    automaticos,
    "Nadie los eligió: el sistema cerró el lead al agotarse el plazo sin contacto."
  );

  agregar("", "", "");

  // --- Llamadas ---
  agregar("LLAMADAS", "", "", { seccion: true });
  const contestadas = llamadas.filter((c) => c.contestada).length;
  agregar("Llamadas realizadas", llamadas.length, "Intentos registrados en el periodo, incluidos los que no contestaron.");
  agregar("Llamadas contestadas", contestadas, "El cliente llegó a contestar.");
  agregar("% de contacto", llamadas.length ? contestadas / llamadas.length : 0, "Contestadas entre realizadas.", { pct: true });
  agregar(
    "Llamadas por venta",
    vivas.length ? llamadas.length / vivas.length : 0,
    "Cuántos intentos cuesta una venta. Mezcla llamadas y ventas del periodo, así que es una referencia, no una razón exacta."
  );

  for (const f of filas) {
    const fila = sheet.addRow({ indicador: f.indicador, valor: f.valor, nota: f.nota });
    if (f.seccion) {
      fila.getCell("indicador").font = { bold: true, color: { argb: MORADO }, size: 11 };
    }
    if (f.dinero) fila.getCell("valor").numFmt = FMT_DINERO;
    if (f.pct) fila.getCell("valor").numFmt = FMT_PCT;
    if (f.alerta && Number(f.valor) > 0) {
      fila.getCell("valor").font = { bold: true, color: { argb: ROJO } };
    }
    fila.getCell("nota").alignment = { wrapText: true, vertical: "top" };
  }

  rematar(sheet, { zebra: false });
  // El resumen no lleva filtro: no es una tabla, es una lista de lectura.
  sheet.autoFilter = undefined;
  return sheet;
}

// --- Hoja 2: Detalle de leads ---------------------------------------
function hojaLeads(wb, leads, truncado) {
  const sheet = wb.addWorksheet("Leads");
  sheet.columns = [
    { header: "Folio PS", key: "folioPS", width: 13 },
    { header: "Folio proveedor", key: "folio", width: 16 },
    { header: "Entró", key: "createdAt", width: 17 },
    { header: "Origen", key: "source", width: 10 },
    { header: "Estatus", key: "estatus", width: 16 },
    { header: "Qué pasó en la llamada", key: "substatus", width: 26 },
    { header: "Motivo de caída", key: "motivo", width: 30 },
    { header: "Clave del motivo", key: "motivoClave", width: 20 },
    { header: "¿Culpa del proveedor?", key: "culpa", width: 20 },
    { header: "¿Lo cerró el sistema?", key: "automatico", width: 19 },
    { header: "Nota del motivo", key: "motivoNota", width: 40 },
    { header: "Descartado el", key: "descartadoAt", width: 17 },
    { header: "Descartado por", key: "descartadoPor", width: 20 },
    { header: "Vendedora", key: "vendedor", width: 20 },
    { header: "Asignado el", key: "asignadoAt", width: 17 },
    { header: "Asignado por", key: "asignadoPor", width: 20 },
    { header: "Producto del lead", key: "producto", width: 24 },
    { header: "Producto del catálogo", key: "productoCat", width: 24 },
    { header: "SKU catálogo", key: "sku", width: 16 },
    { header: "Cantidad", key: "cantidad", width: 9 },
    { header: "Llamadas", key: "llamadas", width: 10 },
    { header: "Contestadas", key: "contestadas", width: 12 },
    { header: "1a llamada", key: "primeraLlamadaAt", width: 17 },
    { header: "Último desenlace", key: "ultimoDesenlace", width: 18 },
    { header: "Intentos esperados", key: "intentosEsperados", width: 17 },
    { header: "Intentos hechos", key: "intentosRealizados", width: 15 },
    { header: "¿Seguimiento incompleto?", key: "seguimientoIncompleto", width: 22 },
    { header: "Devuelto a la cola el", key: "devueltoAt", width: 18 },
    { header: "Motivo de devolución", key: "devueltoMotivo", width: 28 },
    { header: "Devuelto por", key: "devueltoPor", width: 20 },
    { header: "Reagendado para", key: "fechaReagenda", width: 17 },
    { header: "¿Pidió supervisión?", key: "requiereSupervision", width: 18 },
    { header: "Nota de supervisión", key: "supervisionNota", width: 36 },
    { header: "Solicitud especial", key: "solicitudEspecial", width: 36 },
    { header: "Cliente", key: "nombre", width: 24 },
    { header: "Nombre como llegó", key: "nombreOriginal", width: 24 },
    { header: "Teléfono", key: "telefono", width: 15 },
    { header: "Dirección", key: "direccion", width: 52 },
    { header: "CP", key: "cp", width: 9 },
    { header: "¿Cobertura FullVector?", key: "cobertura", width: 20 },
    { header: "Folio de venta", key: "ventaFolio", width: 14 },
    { header: "Monto vendido", key: "ventaMonto", width: 14 },
    { header: "Entrega", key: "entrega", width: 20 },
  ];

  for (const l of leads) {
    const motivo = MOTIVO_POR_CLAVE[l.motivoDescarte];
    const resultado = RESULTADO_POR_CLAVE[l.substatus];
    const contestadas = l.llamadas.filter((c) => c.contestada).length;

    const fila = sheet.addRow({
      folioPS: l.folioPS || "",
      folio: l.folio || "",
      createdAt: l.createdAt,
      source: l.source,
      estatus: LEAD_STATUS_LABELS[l.status] || l.status,
      substatus: resultado?.label || l.substatus || "",
      motivo: l.motivoDescarte ? motivoLabel(l.motivoDescarte) : "",
      motivoClave: l.motivoDescarte || "",
      // Vacio y no "No" cuando no hay motivo: un lead vivo no es que no sea
      // culpa del proveedor, es que todavia no se ha caido.
      culpa: motivo ? si(motivo.culpaDelProveedor) : "",
      automatico: motivo ? si(motivo.automatico) : "",
      motivoNota: l.motivoDescarteNota || "",
      descartadoAt: l.descartadoAt || "",
      descartadoPor: l.descartadoPor?.nombre || "",
      vendedor: l.vendedor?.nombre || "Sin asignar",
      asignadoAt: l.asignadoAt || "",
      asignadoPor: l.asignadoPor?.nombre || (l.asignadoPorCoordinador ? "Coordinación" : "Reparto automático"),
      producto: l.producto,
      productoCat: l.productoCatalogo?.nombre || "",
      sku: l.productoCatalogo?.sku || "",
      cantidad: l.cantidad,
      llamadas: l.llamadas.length,
      contestadas,
      primeraLlamadaAt: l.primeraLlamadaAt || "",
      ultimoDesenlace: l.ultimoDesenlace || "",
      intentosEsperados: l.intentosEsperados ?? "",
      intentosRealizados: l.intentosRealizados ?? "",
      seguimientoIncompleto: si(l.seguimientoIncompleto),
      devueltoAt: l.devueltoAt || "",
      devueltoMotivo: l.devueltoMotivo || "",
      devueltoPor: l.devueltoPorNombre || "",
      fechaReagenda: l.fechaReagenda || "",
      requiereSupervision: si(l.requiereSupervision),
      supervisionNota: l.supervisionNota || "",
      solicitudEspecial: l.solicitudEspecial || "",
      nombre: l.nombre,
      nombreOriginal: l.nombreOriginal || "",
      telefono: l.telefono,
      direccion: direccionCompleta(l),
      cp: l.zipCode || "",
      cobertura: l.coberturaFv === null ? "Sin verificar" : si(l.coberturaFv),
      ventaFolio: l.venta?.folio || "",
      ventaMonto: l.venta ? l.venta.monto : "",
      entrega: estadoEntrega(l.venta),
    });

    formato(fila, ["createdAt", "descartadoAt", "asignadoAt", "primeraLlamadaAt", "devueltoAt", "fechaReagenda"], FMT_FECHA);
    fila.getCell("ventaMonto").numFmt = FMT_DINERO;
    // El CP como texto: Excel se come el cero inicial y deja de cuadrar
    // con el catalogo de codigos postales.
    fila.getCell("cp").numFmt = "@";
    for (const key of ["motivoNota", "supervisionNota", "solicitudEspecial", "direccion", "devueltoMotivo"]) {
      fila.getCell(key).alignment = { wrapText: true, vertical: "top" };
    }

    fila.getCell("estatus").font = { bold: true, color: { argb: colorEstatus(l.status) } };
    // Un seguimiento incompleto es un reclamo a la operacion, no al lead:
    // se venció el plazo sin hacer los intentos que tocaban.
    if (l.seguimientoIncompleto) {
      fila.getCell("seguimientoIncompleto").font = { bold: true, color: { argb: ROJO } };
    }
  }

  rematar(sheet);
  if (truncado) {
    const aviso = sheet.addRow({
      folioPS: `AVISO: el periodo tiene más de ${MAX_DETALLE} leads y la hoja se cortó aquí. Para el detalle completo, pide periodos más cortos.`,
    });
    aviso.font = { bold: true, color: { argb: ROJO } };
  }
  return sheet;
}

// --- Hoja 3: Motivos de caída ---------------------------------------
//
// El agregado que contesta la pregunta del negocio: cuanto de lo que se
// cayo es culpa de la base y cuanto es trabajo comercial. Se ordena por
// cantidad porque lo primero que se busca es el motivo dominante.
function hojaMotivos(wb, descartes) {
  const sheet = wb.addWorksheet("Motivos de caída");
  sheet.columns = [
    { header: "Motivo", key: "label", width: 36 },
    { header: "Clave", key: "clave", width: 22 },
    { header: "Leads", key: "total", width: 9 },
    { header: "% de las caídas", key: "pct", width: 15 },
    { header: "¿Culpa del proveedor?", key: "culpa", width: 20 },
    { header: "¿Lo cerró el sistema?", key: "automatico", width: 19 },
    { header: "Con nota escrita", key: "conNota", width: 15 },
    { header: "¿Motivo retirado?", key: "obsoleto", width: 17 },
    { header: "Qué significa", key: "ayuda", width: 62 },
  ];

  const porMotivo = new Map();
  for (const d of descartes) {
    const clave = d.motivoDescarte || "(sin motivo)";
    const acc = porMotivo.get(clave) || { total: 0, conNota: 0 };
    acc.total += 1;
    if (d.motivoDescarteNota) acc.conNota += 1;
    porMotivo.set(clave, acc);
  }

  const filas = [...porMotivo.entries()].sort((a, b) => b[1].total - a[1].total);

  for (const [clave, acc] of filas) {
    const m = MOTIVO_POR_CLAVE[clave];
    const fila = sheet.addRow({
      label: m?.label || (clave === "(sin motivo)" ? "Sin motivo capturado" : clave),
      clave,
      total: acc.total,
      pct: descartes.length ? acc.total / descartes.length : 0,
      culpa: m ? si(m.culpaDelProveedor) : "",
      automatico: m ? si(m.automatico) : "",
      conNota: acc.conNota,
      obsoleto: m ? si(m.obsoleto) : "",
      ayuda:
        m?.ayuda ||
        (clave === "(sin motivo)"
          ? "Leads descartados antes de que existiera el catálogo de motivos, o cerrados sin capturarlo."
          : ""),
    });
    fila.getCell("pct").numFmt = FMT_PCT;
    fila.getCell("ayuda").alignment = { wrapText: true, vertical: "top" };
    if (m?.culpaDelProveedor) {
      fila.getCell("culpa").font = { bold: true, color: { argb: ROJO } };
    }
  }

  // Los totales van al final y en negritas: es lo que se copia al correo.
  const culpa = descartes.filter((d) => MOTIVO_POR_CLAVE[d.motivoDescarte]?.culpaDelProveedor).length;
  sheet.addRow({});
  const t1 = sheet.addRow({ label: "TOTAL DE CAÍDAS", total: descartes.length, pct: 1 });
  const t2 = sheet.addRow({
    label: "  Culpa del proveedor",
    total: culpa,
    pct: descartes.length ? culpa / descartes.length : 0,
    ayuda: "El lead nunca sirvió. Es lo que se le reclama al proveedor.",
  });
  const t3 = sheet.addRow({
    label: "  No se cerró la venta",
    total: descartes.length - culpa,
    pct: descartes.length ? (descartes.length - culpa) / descartes.length : 0,
    ayuda: "El lead era real y contestó. Es trabajo comercial.",
  });
  for (const t of [t1, t2, t3]) {
    t.font = { bold: true };
    t.getCell("pct").numFmt = FMT_PCT;
    t.getCell("ayuda").alignment = { wrapText: true, vertical: "top" };
  }

  rematar(sheet, { zebra: false });
  return sheet;
}

// --- Hoja 4: Ventas --------------------------------------------------
function hojaVentas(wb, ventas) {
  const sheet = wb.addWorksheet("Ventas");
  sheet.columns = [
    { header: "Folio venta", key: "folio", width: 14 },
    { header: "Folio PS", key: "folioPS", width: 13 },
    { header: "Fecha de venta", key: "fecha", width: 17 },
    { header: "Entró el lead", key: "leadCreatedAt", width: 17 },
    { header: "Días para cerrar", key: "dias", width: 14 },
    { header: "Vendedora", key: "vendedor", width: 20 },
    { header: "Cliente", key: "cliente", width: 24 },
    { header: "Teléfono", key: "telefono", width: 15 },
    { header: "Producto", key: "producto", width: 24 },
    { header: "Artículos", key: "items", width: 40 },
    { header: "Monto producto", key: "monto", width: 14 },
    { header: "Envío", key: "envio", width: 12 },
    { header: "Total cobrado", key: "total", width: 14 },
    { header: "Comisión", key: "comision", width: 12 },
    { header: "Entrega", key: "entrega", width: 20 },
    { header: "Entrega confirmada el", key: "entregaAt", width: 18 },
    { header: "Confirmada por", key: "entregaPor", width: 20 },
    { header: "¿Cancelada?", key: "cancelada", width: 12 },
    { header: "Motivo de cancelación", key: "canceladaMotivo", width: 34 },
    { header: "Orden FullVector", key: "fvOrden", width: 24 },
    { header: "Sincronización", key: "fvStatus", width: 16 },
    { header: "Error de sincronización", key: "fvError", width: 40 },
    { header: "Dirección", key: "direccion", width: 52 },
    { header: "CP", key: "cp", width: 9 },
  ];

  for (const v of ventas) {
    const l = v.lead;
    const dias = l ? Math.max(0, Math.round((v.fecha - l.createdAt) / 86400000)) : "";
    const fila = sheet.addRow({
      folio: v.folio || "",
      folioPS: l?.folioPS || "",
      fecha: v.fecha,
      leadCreatedAt: l?.createdAt || "",
      dias,
      vendedor: v.vendedor?.nombre || "",
      cliente: l?.nombre || "",
      telefono: l?.telefono || "",
      producto: l?.producto || "",
      // Lo que realmente se vendio, que puede no ser el producto del lead:
      // el carrito admite secundarios y regalos.
      items: (l?.items || [])
        .map((it) => `${it.cantidad}x ${it.producto?.nombre || "?"}${it.esRegalo ? " (regalo)" : ""}`)
        .join(", "),
      monto: v.monto,
      envio: v.costoEnvio || 0,
      total: v.monto + (v.costoEnvio || 0),
      comision: v.comision || 0,
      entrega: estadoEntrega(v),
      entregaAt: v.entregaConfirmadaAt || "",
      entregaPor: v.entregaConfirmadaPor || "",
      cancelada: si(v.cancelada),
      canceladaMotivo: v.canceladaMotivo || "",
      fvOrden: v.fullvectorOrderId || "",
      fvStatus: v.fullvectorSyncStatus,
      fvError: v.fullvectorError || "",
      direccion: l ? direccionCompleta(l) : "",
      cp: l?.zipCode || "",
    });

    formato(fila, ["monto", "envio", "total", "comision"], FMT_DINERO);
    formato(fila, ["fecha", "leadCreatedAt", "entregaAt"], FMT_FECHA);
    fila.getCell("cp").numFmt = "@";
    for (const key of ["direccion", "items", "canceladaMotivo", "fvError"]) {
      fila.getCell(key).alignment = { wrapText: true, vertical: "top" };
    }
    if (v.cancelada) {
      fila.getCell("cancelada").font = { bold: true, color: { argb: ROJO } };
    }
    if (!v.cancelada && v.fullvectorSyncStatus !== "SYNCED") {
      fila.getCell("entrega").font = { bold: true, color: { argb: ROJO } };
    }
  }

  rematar(sheet);
  return sheet;
}

// --- Hoja 5: Vendedoras ----------------------------------------------
function hojaVendedoras(wb, { leads, ventas, llamadas }) {
  const sheet = wb.addWorksheet("Vendedoras");
  sheet.columns = [
    { header: "Vendedora", key: "nombre", width: 24 },
    { header: "Leads asignados", key: "asignados", width: 15 },
    { header: "Llamadas", key: "llamadas", width: 10 },
    { header: "Contestadas", key: "contestadas", width: 12 },
    { header: "% de contacto", key: "pctContacto", width: 14 },
    { header: "Concretadas", key: "ventas", width: 12 },
    { header: "Tasa de cierre", key: "pctCierre", width: 14 },
    { header: "Monto vendido", key: "monto", width: 15 },
    { header: "Comisión", key: "comision", width: 13 },
    { header: "Ticket promedio", key: "ticket", width: 15 },
    { header: "Caídos", key: "caidos", width: 10 },
    { header: "Llamadas por venta", key: "porVenta", width: 17 },
  ];

  // Se arma por id y no por nombre: dos personas pueden llamarse igual, y
  // juntarlas en una fila le quita o le regala ventas a alguien.
  const acc = new Map();
  const tomar = (id, nombre) => {
    if (!acc.has(id)) {
      acc.set(id, { nombre, asignados: 0, llamadas: 0, contestadas: 0, ventas: 0, monto: 0, comision: 0, caidos: 0 });
    }
    return acc.get(id);
  };

  for (const l of leads) {
    if (!l.vendedorId) continue;
    const a = tomar(l.vendedorId, l.vendedor?.nombre || `#${l.vendedorId}`);
    a.asignados += 1;
    if (l.status === "DESCARTADO" || l.status === "NO_CONCRETADO") a.caidos += 1;
  }
  for (const c of llamadas) {
    const a = tomar(c.vendedorId, c.vendedor?.nombre || `#${c.vendedorId}`);
    a.llamadas += 1;
    if (c.contestada) a.contestadas += 1;
  }
  for (const v of ventas) {
    if (v.cancelada) continue;
    const a = tomar(v.vendedorId, v.vendedor?.nombre || `#${v.vendedorId}`);
    a.ventas += 1;
    a.monto += v.monto;
    a.comision += v.comision || 0;
  }

  const filas = [...acc.values()].sort((x, y) => y.ventas - x.ventas || y.monto - x.monto);

  for (const a of filas) {
    const fila = sheet.addRow({
      nombre: a.nombre,
      asignados: a.asignados,
      llamadas: a.llamadas,
      contestadas: a.contestadas,
      pctContacto: a.llamadas ? a.contestadas / a.llamadas : 0,
      ventas: a.ventas,
      // Sobre los leads que se le asignaron en el periodo. Si no se le
      // asigno ninguno (trabajo leads viejos) la tasa no significa nada y
      // se deja vacia en vez de dar 0% o dividir entre cero.
      pctCierre: a.asignados ? a.ventas / a.asignados : "",
      monto: a.monto,
      comision: a.comision,
      ticket: a.ventas ? a.monto / a.ventas : 0,
      caidos: a.caidos,
      porVenta: a.ventas ? Math.round((a.llamadas / a.ventas) * 10) / 10 : "",
    });
    formato(fila, ["monto", "comision", "ticket"], FMT_DINERO);
    formato(fila, ["pctContacto", "pctCierre"], FMT_PCT);
  }

  rematar(sheet);
  return sheet;
}

// GET /api/admin/reportes/export?desde=2026-11-01&hasta=2026-11-30
router.get("/export", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const inicio = inicioDeDia(req.query.desde);
    const fin = finDeDia(req.query.hasta);

    if (!inicio || !fin) {
      return res.status(400).json({ error: "Hay que indicar el periodo: desde y hasta (AAAA-MM-DD)" });
    }
    if (inicio > fin) {
      return res.status(400).json({ error: "La fecha inicial es posterior a la final" });
    }
    const dias = Math.round((fin - inicio) / 86400000) + 1;
    if (dias > MAX_DIAS) {
      return res.status(400).json({ error: `El periodo no puede pasar de ${MAX_DIAS} días` });
    }

    const enRango = { gte: inicio, lte: fin };

    const [leads, ventas, llamadas, descartes] = await Promise.all([
      // Los leads que ENTRARON en el periodo.
      prisma.lead.findMany({
        where: { tenantId, createdAt: enRango },
        select: {
          id: true, folioPS: true, folio: true, createdAt: true, source: true, status: true,
          substatus: true, motivoDescarte: true, motivoDescarteNota: true, descartadoAt: true,
          vendedorId: true, asignadoAt: true, asignadoPorCoordinador: true,
          producto: true, cantidad: true, primeraLlamadaAt: true, ultimoDesenlace: true,
          intentosEsperados: true, intentosRealizados: true, seguimientoIncompleto: true,
          devueltoAt: true, devueltoMotivo: true, devueltoPorNombre: true,
          fechaReagenda: true, requiereSupervision: true, supervisionNota: true,
          solicitudEspecial: true, nombre: true, nombreOriginal: true, telefono: true,
          shippingStreet: true, shippingNumber: true, colonia: true, municipio: true,
          state: true, zipCode: true, coberturaFv: true,
          vendedor: { select: { nombre: true } },
          asignadoPor: { select: { nombre: true } },
          descartadoPor: { select: { nombre: true } },
          productoCatalogo: { select: { nombre: true, sku: true } },
          venta: {
            select: {
              folio: true, monto: true, cancelada: true, entregaExitosa: true,
              fullvectorSyncStatus: true, fullvectorSinCobertura: true,
            },
          },
          llamadas: { select: { contestada: true } },
        },
        orderBy: { createdAt: "asc" },
        take: MAX_DETALLE + 1,
      }),

      // Las ventas CERRADAS en el periodo.
      prisma.venta.findMany({
        where: { tenantId, fecha: enRango },
        select: {
          folio: true, fecha: true, monto: true, costoEnvio: true, comision: true,
          cancelada: true, canceladaMotivo: true, entregaExitosa: true,
          entregaConfirmadaAt: true, entregaConfirmadaPor: true,
          fullvectorOrderId: true, fullvectorSyncStatus: true, fullvectorSinCobertura: true,
          fullvectorError: true, vendedorId: true,
          vendedor: { select: { nombre: true } },
          lead: {
            select: {
              folioPS: true, createdAt: true, nombre: true, telefono: true, producto: true,
              shippingStreet: true, shippingNumber: true, colonia: true, municipio: true,
              state: true, zipCode: true,
              items: { select: { cantidad: true, esRegalo: true, producto: { select: { nombre: true } } } },
            },
          },
        },
        orderBy: { fecha: "asc" },
      }),

      // Las llamadas HECHAS en el periodo.
      prisma.llamada.findMany({
        where: { tenantId, fecha: enRango },
        select: {
          contestada: true, vendedorId: true,
          vendedor: { select: { nombre: true } },
        },
      }),

      // Los leads DESCARTADOS en el periodo, entraran cuando entraran. Es
      // otra poblacion que la de `leads`: un lead de marzo se puede caer en
      // abril, y para el reporte de calidad del mes cuenta en abril.
      prisma.lead.findMany({
        where: { tenantId, descartadoAt: enRango },
        select: { motivoDescarte: true, motivoDescarteNota: true },
      }),
    ]);

    const truncado = leads.length > MAX_DETALLE;
    const leadsHoja = truncado ? leads.slice(0, MAX_DETALLE) : leads;

    const wb = new ExcelJS.Workbook();
    wb.creator = "Perfect Sales";
    wb.created = new Date();

    hojaResumen(wb, { desde: inicio, hasta: fin, leads, ventas, llamadas, descartes });
    hojaLeads(wb, leadsHoja, truncado);
    hojaMotivos(wb, descartes);
    hojaVentas(wb, ventas);
    hojaVendedoras(wb, { leads, ventas, llamadas });

    const nombre = `reporte_${req.query.desde}_a_${req.query.hasta}.xlsx`;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
