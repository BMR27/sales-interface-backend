// Reporte de un comprador del proveedor (buyerId), en Excel.
//
// `buyerId` es el identificador del comprador en el sistema del proveedor:
// nos llega en el payload, lo guardamos opaco y lo devolvemos tal cual
// para que el proveedor concilie por el. Cuando hay que responder "¿como
// se portaron los leads que me mandaste de este comprador?", este es el
// corte que contesta.
//
// Se parte de incoming_leads y no de leads a proposito: ahi esta el
// buyerId y ahi esta lo que el proveedor mando de verdad. Un incoming que
// se rechazo (duplicado, invalido) NO tiene lead asociado, y justamente
// esos son los que interesan en una conciliacion -- empezar por leads los
// dejaria fuera y el total no cuadraria con lo que el proveedor cree
// haber mandado.
//
//   node scripts/reporte-buyer.js 4195
//   node scripts/reporte-buyer.js 4195 --dias 5
//   node scripts/reporte-buyer.js 4195 --dias 5 --salida /ruta/archivo.xlsx
//   node scripts/reporte-buyer.js 4195 --base64     (lo escupe a stdout,
//       para traerlo desde fuera del contenedor sin volumen compartido)
const ExcelJS = require("exceljs");
const fs = require("fs");
const prisma = require("../src/lib/prisma");
const { LEAD_STATUS_LABELS } = require("../src/lib/leadStatus");
const { POR_CLAVE: MOTIVO_POR_CLAVE, motivoLabel } = require("../src/lib/motivosDescarte");
const { POR_CLAVE: RESULTADO_POR_CLAVE } = require("../src/lib/resultadosLlamada");
const {
  MORADO, VERDE, ROJO, GRIS,
  FMT_DINERO, FMT_FECHA, FMT_PCT,
  rematar, formato, envolver, si, direccionCompleta, estadoEntrega, colorEstatus,
} = require("../src/lib/excelEstilo");

function arg(nombre, pordefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const BUYER = process.argv[2];
const DIAS = Number(arg("dias", 5));
const BASE64 = process.argv.includes("--base64");
const SALIDA = arg("salida", `reporte_buyer_${BUYER}_${DIAS}d.xlsx`);

const fechaCorta = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

(async () => {
  if (!BUYER) {
    console.error("Falta el buyerId. Ej: node scripts/reporte-buyer.js 4195 --dias 5");
    process.exit(1);
  }

  // La ventana se cuenta hacia atras desde ahora. "Ultimos 5 dias" en una
  // conciliacion significa las ultimas 120 horas, no cinco casillas del
  // calendario: el proveedor manda a toda hora.
  const desde = new Date(Date.now() - DIAS * 86400000);

  const entrantes = await prisma.incomingLead.findMany({
    where: { buyerId: BUYER, createdAt: { gte: desde } },
    orderBy: { createdAt: "asc" },
    include: {
      apiKey: { select: { label: true } },
      assignedLead: {
        include: {
          vendedor: { select: { nombre: true } },
          descartadoPor: { select: { nombre: true } },
          productoCatalogo: { select: { nombre: true, sku: true } },
          venta: true,
          llamadas: { select: { contestada: true, fecha: true, duracion: true }, orderBy: { fecha: "asc" } },
        },
      },
    },
  });

  if (entrantes.length === 0) {
    console.error(`Sin leads del comprador ${BUYER} en los últimos ${DIAS} días.`);
    process.exit(1);
  }

  const leads = entrantes.map((e) => e.assignedLead).filter(Boolean);
  const ventas = leads.map((l) => l.venta).filter((v) => v && !v.cancelada);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Perfect Sales";
  wb.created = new Date();

  // ---------------------------------------------------------------
  // Hoja 1: Resumen
  // ---------------------------------------------------------------
  const resumen = wb.addWorksheet("Resumen");
  resumen.columns = [
    { header: "Indicador", key: "indicador", width: 40 },
    { header: "Valor", key: "valor", width: 18 },
    { header: "Cómo se mide", key: "nota", width: 74 },
  ];

  const filas = [];
  const add = (indicador, valor, nota, opts = {}) => filas.push({ indicador, valor, nota, ...opts });

  add("Comprador (buyerId)", BUYER, "Identificador del comprador en el sistema del proveedor.");
  add("Periodo", `Últimos ${DIAS} días`, `Desde ${desde.toLocaleString("es-MX")} hasta ahora.`);
  add("Proveedor", entrantes[0].apiKey?.label || "—", "La API key por la que entraron estos leads.");
  add("", "", "");

  add("LO QUE MANDÓ EL PROVEEDOR", "", "", { seccion: true });
  add("Leads recibidos", entrantes.length, "Registros que llegaron por la API con este buyerId.");

  const porEstadoIngesta = {};
  for (const e of entrantes) porEstadoIngesta[e.status] = (porEstadoIngesta[e.status] || 0) + 1;
  for (const [st, n] of Object.entries(porEstadoIngesta)) {
    add(`  ${st}`, n, st === "RECEIVED" ? "Aceptado y convertido en lead trabajable." : "No se convirtió en lead; ver la hoja «Recibidos».");
  }

  const productos = [...new Set(entrantes.map((e) => e.product))];
  add("Productos distintos", productos.length, productos.join(", "));
  add("", "", "");

  add("CÓMO SE TRABAJARON", "", "", { seccion: true });
  const porStatus = {};
  for (const l of leads) porStatus[l.status] = (porStatus[l.status] || 0) + 1;
  for (const [st, n] of Object.entries(porStatus)) {
    add(`  ${LEAD_STATUS_LABELS[st] || st}`, n, "Estado en que está HOY el lead.");
  }

  const llamadas = leads.flatMap((l) => l.llamadas);
  const contestadas = llamadas.filter((c) => c.contestada).length;
  const sinLlamar = leads.filter((l) => l.llamadas.length === 0).length;
  add("Llamadas realizadas", llamadas.length, "Intentos sobre los leads de este comprador.");
  add("Llamadas contestadas", contestadas, "El cliente llegó a contestar.");
  add("% de contacto", llamadas.length ? contestadas / llamadas.length : 0, "Contestadas entre realizadas.", { pct: true });
  add("Leads sin llamar todavía", sinLlamar, "Aún no se les ha marcado una sola vez.", { alerta: sinLlamar > 0 });
  add("", "", "");

  add("RESULTADO", "", "", { seccion: true });
  const monto = ventas.reduce((a, v) => a + v.monto, 0);
  const envio = ventas.reduce((a, v) => a + (v.costoEnvio || 0), 0);
  add("Concretadas", ventas.length, "Ventas no canceladas de estos leads.");
  add("Tasa de cierre", leads.length ? ventas.length / leads.length : 0, "Concretadas entre los leads recibidos en el periodo.", { pct: true });
  add("Monto de producto", monto, "Sin el envío.", { dinero: true });
  add("Total cobrado", monto + envio, "Producto más envío.", { dinero: true });
  add("Ticket promedio", ventas.length ? monto / ventas.length : 0, "Monto entre concretadas.", { dinero: true });

  const caidos = leads.filter((l) => l.motivoDescarte);
  const culpa = caidos.filter((l) => MOTIVO_POR_CLAVE[l.motivoDescarte]?.culpaDelProveedor).length;
  add("Leads caídos", caidos.length, "Con motivo de descarte capturado.");
  add("  Culpa del proveedor", culpa, "El lead nunca sirvió: número inexistente, equivocado, duplicado, nunca contestó.", { alerta: culpa > 0 });
  add("  No se cerró la venta", caidos.length - culpa, "El lead era real y contestó, pero no compró.");
  add(
    "% de la base que no sirvió",
    caidos.length ? culpa / caidos.length : 0,
    "Culpa del proveedor entre los caídos. Es la cifra de calidad de esta remesa.",
    { pct: true, alerta: caidos.length > 0 && culpa / caidos.length > 0.3 }
  );

  for (const f of filas) {
    const fila = resumen.addRow({ indicador: f.indicador, valor: f.valor, nota: f.nota });
    if (f.seccion) fila.getCell("indicador").font = { bold: true, color: { argb: MORADO }, size: 11 };
    if (f.dinero) fila.getCell("valor").numFmt = FMT_DINERO;
    if (f.pct) fila.getCell("valor").numFmt = FMT_PCT;
    if (f.alerta) fila.getCell("valor").font = { bold: true, color: { argb: ROJO } };
    envolver(fila, ["nota"]);
  }
  rematar(resumen, { zebra: false, filtro: false });

  // ---------------------------------------------------------------
  // Hoja 2: Detalle de cada lead
  // ---------------------------------------------------------------
  const det = wb.addWorksheet("Leads");
  det.columns = [
    { header: "#", key: "n", width: 5 },
    { header: "Folio proveedor", key: "folioProv", width: 15 },
    { header: "Folio PS", key: "folioPS", width: 13 },
    { header: "Recibido", key: "recibido", width: 17 },
    { header: "Estatus", key: "estatus", width: 16 },
    { header: "Qué pasó en la llamada", key: "substatus", width: 26 },
    { header: "Motivo de caída", key: "motivo", width: 30 },
    { header: "¿Culpa del proveedor?", key: "culpa", width: 20 },
    { header: "Nota del motivo", key: "nota", width: 36 },
    { header: "Descartado por", key: "descartadoPor", width: 18 },
    { header: "Vendedora", key: "vendedor", width: 20 },
    { header: "Llamadas", key: "llamadas", width: 10 },
    { header: "Contestadas", key: "contestadas", width: 12 },
    { header: "1a llamada", key: "primera", width: 17 },
    { header: "Última llamada", key: "ultima", width: 17 },
    { header: "Minutos hablados", key: "minutos", width: 16 },
    { header: "Producto que mandó", key: "producto", width: 22 },
    { header: "SKU que mandó", key: "sku", width: 16 },
    { header: "Producto del catálogo", key: "productoCat", width: 22 },
    { header: "Cliente", key: "cliente", width: 24 },
    { header: "Teléfono", key: "telefono", width: 15 },
    { header: "Estado", key: "estado", width: 18 },
    { header: "CP", key: "cp", width: 9 },
    { header: "Dirección", key: "direccion", width: 48 },
    { header: "Monto", key: "monto", width: 13 },
    { header: "Entrega", key: "entrega", width: 20 },
  ];

  let n = 0;
  for (const e of entrantes) {
    const l = e.assignedLead;
    n += 1;
    const cont = l ? l.llamadas.filter((c) => c.contestada).length : 0;
    const segs = l ? l.llamadas.reduce((a, c) => a + (c.duracion || 0), 0) : 0;

    const fila = det.addRow({
      n,
      folioProv: e.folio,
      folioPS: l?.folioPS || "",
      recibido: e.createdAt,
      estatus: l ? LEAD_STATUS_LABELS[l.status] || l.status : `No ingresó (${e.status})`,
      substatus: l ? RESULTADO_POR_CLAVE[l.substatus]?.label || l.substatus || "" : "",
      motivo: l?.motivoDescarte ? motivoLabel(l.motivoDescarte) : "",
      culpa: l?.motivoDescarte ? si(MOTIVO_POR_CLAVE[l.motivoDescarte]?.culpaDelProveedor) : "",
      nota: l?.motivoDescarteNota || e.errorMessage || "",
      descartadoPor: l?.descartadoPor?.nombre || "",
      vendedor: l?.vendedor?.nombre || "Sin asignar",
      llamadas: l ? l.llamadas.length : "",
      contestadas: l ? cont : "",
      primera: l?.llamadas[0]?.fecha || "",
      ultima: l?.llamadas[l.llamadas.length - 1]?.fecha || "",
      minutos: segs ? Math.round((segs / 60) * 10) / 10 : "",
      producto: e.product,
      sku: e.internalSku || e.externalSku || "",
      productoCat: l?.productoCatalogo?.nombre || "",
      cliente: l?.nombre || e.consumerName,
      telefono: l?.telefono || e.phone,
      estado: l?.state || e.state || "",
      cp: l?.zipCode || e.zipCode || "",
      direccion: direccionCompleta(l),
      monto: l?.venta && !l.venta.cancelada ? l.venta.monto : "",
      entrega: estadoEntrega(l?.venta),
    });

    formato(fila, ["recibido", "primera", "ultima"], FMT_FECHA);
    fila.getCell("monto").numFmt = FMT_DINERO;
    fila.getCell("cp").numFmt = "@";
    envolver(fila, ["nota", "direccion"]);
    fila.getCell("estatus").font = {
      bold: true,
      color: { argb: l ? colorEstatus(l.status) : ROJO },
    };
    // Un lead sin una sola llamada despues de varios dias es lo primero
    // que hay que poder ver: no es culpa de la base.
    if (l && l.llamadas.length === 0) {
      fila.getCell("llamadas").font = { bold: true, color: { argb: ROJO } };
    }
  }
  rematar(det);

  // ---------------------------------------------------------------
  // Hoja 3: Por día
  // ---------------------------------------------------------------
  const dias = wb.addWorksheet("Por día");
  dias.columns = [
    { header: "Día", key: "dia", width: 14 },
    { header: "Recibidos", key: "recibidos", width: 12 },
    { header: "Llamados", key: "llamados", width: 11 },
    { header: "Sin llamar", key: "sinLlamar", width: 12 },
    { header: "Concretadas", key: "ventas", width: 13 },
    { header: "Caídos", key: "caidos", width: 10 },
    { header: "Tasa de cierre", key: "tasa", width: 14 },
    { header: "Monto", key: "monto", width: 14 },
  ];

  const porDia = new Map();
  for (const e of entrantes) {
    const d = fechaCorta(e.createdAt);
    const a = porDia.get(d) || { recibidos: 0, llamados: 0, sinLlamar: 0, ventas: 0, caidos: 0, monto: 0 };
    a.recibidos += 1;
    const l = e.assignedLead;
    if (l) {
      if (l.llamadas.length > 0) a.llamados += 1;
      else a.sinLlamar += 1;
      if (l.venta && !l.venta.cancelada) { a.ventas += 1; a.monto += l.venta.monto }
      if (l.motivoDescarte) a.caidos += 1;
    }
    porDia.set(d, a);
  }

  for (const [d, a] of [...porDia.entries()].sort()) {
    const fila = dias.addRow({
      dia: d,
      recibidos: a.recibidos,
      llamados: a.llamados,
      sinLlamar: a.sinLlamar,
      ventas: a.ventas,
      caidos: a.caidos,
      tasa: a.recibidos ? a.ventas / a.recibidos : 0,
      monto: a.monto,
    });
    fila.getCell("tasa").numFmt = FMT_PCT;
    fila.getCell("monto").numFmt = FMT_DINERO;
    if (a.sinLlamar > 0) fila.getCell("sinLlamar").font = { bold: true, color: { argb: ROJO } };
  }

  const tot = dias.addRow({
    dia: "TOTAL",
    recibidos: entrantes.length,
    llamados: leads.filter((l) => l.llamadas.length > 0).length,
    sinLlamar,
    ventas: ventas.length,
    caidos: caidos.length,
    tasa: entrantes.length ? ventas.length / entrantes.length : 0,
    monto,
  });
  tot.font = { bold: true };
  tot.getCell("tasa").numFmt = FMT_PCT;
  tot.getCell("monto").numFmt = FMT_DINERO;
  rematar(dias, { zebra: false });

  // ---------------------------------------------------------------
  // Hoja 4: Motivos de caída
  // ---------------------------------------------------------------
  const mot = wb.addWorksheet("Motivos de caída");
  mot.columns = [
    { header: "Motivo", key: "label", width: 36 },
    { header: "Clave", key: "clave", width: 22 },
    { header: "Leads", key: "total", width: 9 },
    { header: "% de las caídas", key: "pct", width: 15 },
    { header: "¿Culpa del proveedor?", key: "culpa", width: 20 },
    { header: "Qué significa", key: "ayuda", width: 62 },
  ];

  const agrup = new Map();
  for (const l of caidos) agrup.set(l.motivoDescarte, (agrup.get(l.motivoDescarte) || 0) + 1);
  for (const [clave, total] of [...agrup.entries()].sort((a, b) => b[1] - a[1])) {
    const m = MOTIVO_POR_CLAVE[clave];
    const fila = mot.addRow({
      label: m?.label || clave,
      clave,
      total,
      pct: caidos.length ? total / caidos.length : 0,
      culpa: m ? si(m.culpaDelProveedor) : "",
      ayuda: m?.ayuda || "",
    });
    fila.getCell("pct").numFmt = FMT_PCT;
    envolver(fila, ["ayuda"]);
    if (m?.culpaDelProveedor) fila.getCell("culpa").font = { bold: true, color: { argb: ROJO } };
  }
  if (caidos.length === 0) mot.addRow({ label: "Ningún lead de este comprador se ha caído todavía." });
  rematar(mot, { zebra: false });

  // ---------------------------------------------------------------
  // Hoja 5: Lo recibido, crudo
  // ---------------------------------------------------------------
  //
  // Es la hoja que se le adjunta al proveedor cuando hay que conciliar:
  // lo que mando, tal como lo mando, sin interpretar.
  const crudo = wb.addWorksheet("Recibidos");
  crudo.columns = [
    { header: "Folio proveedor", key: "folio", width: 15 },
    { header: "Recibido", key: "fecha", width: 17 },
    { header: "Estado de ingesta", key: "status", width: 17 },
    { header: "Por qué se rechazó", key: "error", width: 40 },
    { header: "Nombre que mandó", key: "nombre", width: 26 },
    { header: "Teléfono que mandó", key: "telefono", width: 18 },
    { header: "Producto que mandó", key: "producto", width: 22 },
    { header: "SKU interno", key: "internalSku", width: 16 },
    { header: "SKU externo", key: "externalSku", width: 16 },
    { header: "Categoría", key: "categoria", width: 20 },
    { header: "País", key: "pais", width: 8 },
    { header: "Estado", key: "estado", width: 18 },
    { header: "CP", key: "cp", width: 9 },
    { header: "Lead generado", key: "lead", width: 13 },
  ];

  for (const e of entrantes) {
    const fila = crudo.addRow({
      folio: e.folio,
      fecha: e.createdAt,
      status: e.status,
      error: e.errorMessage || "",
      nombre: e.consumerName,
      telefono: e.phone,
      producto: e.product,
      internalSku: e.internalSku || "",
      externalSku: e.externalSku || "",
      categoria: e.category,
      pais: e.country,
      estado: e.state || "",
      cp: e.zipCode || "",
      lead: e.assignedLead?.folioPS || "—",
    });
    fila.getCell("fecha").numFmt = FMT_FECHA;
    fila.getCell("cp").numFmt = "@";
    envolver(fila, ["error"]);
    if (e.status !== "RECEIVED") {
      fila.getCell("status").font = { bold: true, color: { argb: ROJO } };
    }
  }
  rematar(crudo);

  // ---------------------------------------------------------------
  const buffer = await wb.xlsx.writeBuffer();
  if (BASE64) {
    // Sin newlines: el que lo recibe hace un solo decode.
    process.stdout.write(Buffer.from(buffer).toString("base64"));
  } else {
    fs.writeFileSync(SALIDA, Buffer.from(buffer));
    console.log(`${SALIDA}  (${entrantes.length} leads, ${(buffer.byteLength / 1024).toFixed(1)} KB)`);
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
