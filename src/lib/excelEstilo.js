// El aspecto comun de los Excel que salen del sistema.
//
// Vive aparte porque ya son varios los que se generan (reportes por
// periodo, reportes por comprador, kardex, historial) y cada uno se veia
// distinto segun quien lo escribio: otro morado, otro formato de fecha,
// unos con filtro y otros no. Un archivo que llega a un proveedor o a
// direccion tiene que verse como el anterior.
//
// Aqui solo va la PRESENTACION. Que columnas lleva cada reporte y que
// significa cada numero es decision de cada reporte, no de este modulo.

const MORADO = "FF7E5A97";
const GRIS_ZEBRA = "FFF6F4F8";
const VERDE = "FF1B9247";
const ROJO = "FFC0392B";
const AMBAR = "FF9A6A2F";
const GRIS = "FF6B7280";

const FMT_DINERO = '"$"#,##0.00';
const FMT_FECHA = "dd/mm/yyyy hh:mm";
const FMT_DIA = "dd/mm/yyyy";
const FMT_PCT = "0.0%";

// Deja la hoja legible: encabezado de color, filas alternadas, filtro y el
// encabezado congelado. Se aplica al final, cuando ya estan todas las
// filas, porque la zebra necesita saber cuantas son.
function rematar(sheet, { zebra = true, filtro = true } = {}) {
  const encabezado = sheet.getRow(1);
  encabezado.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  encabezado.fill = { type: "pattern", pattern: "solid", fgColor: { argb: MORADO } };
  encabezado.alignment = { vertical: "middle", horizontal: "left" };
  encabezado.height = 22;

  if (zebra) {
    for (let i = 2; i <= sheet.rowCount; i++) {
      if (i % 2 === 0) {
        sheet.getRow(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRIS_ZEBRA } };
      }
    }
  }

  if (filtro) {
    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };
  }
  // Con muchas columnas, perder de vista el encabezado al bajar hace la
  // hoja ilegible: no se sabe que es cada columna.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

// Aplica un formato a varias columnas de una fila de un jalon.
function formato(fila, keys, numFmt) {
  for (const key of keys) fila.getCell(key).numFmt = numFmt;
}

// Texto que se desborda: se envuelve en vez de cortarse.
function envolver(fila, keys) {
  for (const key of keys) fila.getCell(key).alignment = { wrapText: true, vertical: "top" };
}

const si = (v) => (v ? "Sí" : "No");

// La direccion en una sola celda. Suelta en seis columnas no se puede
// pegar en ningun lado; completa sirve para buscar y para mensajeria.
function direccionCompleta(l) {
  if (!l) return "";
  return [
    [l.shippingStreet, l.shippingNumber].filter(Boolean).join(" "),
    l.colonia,
    l.municipio,
    l.state,
    l.zipCode,
  ]
    .filter(Boolean)
    .join(", ");
}

// Como quedo la entrega de una venta, en palabras.
function estadoEntrega(v) {
  if (!v) return "";
  if (v.cancelada) return "Cancelada";
  if (v.fullvectorSyncStatus !== "SYNCED") return "No llegó a FullVector";
  if (v.fullvectorSinCobertura) return "Prepago (sin COD)";
  if (v.entregaExitosa) return "Entregada";
  return "En tránsito";
}

// El color con que se lee un estatus de lead de un vistazo.
function colorEstatus(status) {
  if (status === "VENTA") return VERDE;
  if (status === "DESCARTADO") return ROJO;
  if (status === "NO_CONCRETADO") return AMBAR;
  return GRIS;
}

module.exports = {
  MORADO, GRIS_ZEBRA, VERDE, ROJO, AMBAR, GRIS,
  FMT_DINERO, FMT_FECHA, FMT_DIA, FMT_PCT,
  rematar, formato, envolver, si, direccionCompleta, estadoEntrega, colorEstatus,
};
