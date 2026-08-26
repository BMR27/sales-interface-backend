const ExcelJS = require("exceljs");

const COLUMN_ALIASES = {
  nombre: "nombre",
  cliente: "nombre",
  apellido: "apellido",
  edad: "edad",
  telefono: "telefono",
  tel: "telefono",
  producto: "producto",
  cantidad: "cantidad",
  categoria: "categoria",
  notas: "notas",
  hora: "hora",
  pais: "country",
  country: "country",
  ciudad: "city",
  city: "city",
  ip: "ip",
  direccionip: "ip",
  estado: "state",
  state: "state",
  cp: "zipCode",
  codigopostal: "zipCode",
  zipcode: "zipCode",
  sku: "internalSku",
  internalsku: "internalSku",
  vendedoremail: "vendedorEmail",
  vendedor: "vendedorEmail",
};

const REQUIRED_FIELDS = ["nombre", "telefono", "producto"];

function normalizeHeader(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "");
}

async function parseWorkbookBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const columns = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = COLUMN_ALIASES[normalizeHeader(cell.value)];
    columns[colNumber] = key || null;
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const entry = {};
    let hasData = false;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const field = columns[colNumber];
      if (!field) return;
      let value = cell.value;
      if (value && typeof value === "object" && "text" in value) value = value.text;
      if (value !== null && value !== undefined && value !== "") {
        entry[field] = value;
        hasData = true;
      }
    });
    if (hasData) rows.push({ rowNumber, data: entry });
  });

  return rows;
}

function validateRow(entry) {
  const missing = REQUIRED_FIELDS.filter((f) => !entry[f]);
  if (missing.length > 0) {
    return `Faltan campos requeridos: ${missing.join(", ")}`;
  }
  return null;
}

async function buildTemplateBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");
  sheet.columns = [
    { header: "nombre", key: "nombre", width: 20 },
    { header: "apellido", key: "apellido", width: 20 },
    { header: "edad", key: "edad", width: 8 },
    { header: "telefono", key: "telefono", width: 16 },
    { header: "producto", key: "producto", width: 20 },
    { header: "cantidad", key: "cantidad", width: 10 },
    { header: "categoria", key: "categoria", width: 16 },
    { header: "notas", key: "notas", width: 24 },
    { header: "pais", key: "country", width: 10 },
    { header: "ciudad", key: "city", width: 16 },
    { header: "estado", key: "state", width: 14 },
    { header: "cp", key: "zipCode", width: 10 },
    { header: "ip", key: "ip", width: 16 },
    { header: "sku", key: "internalSku", width: 16 },
    { header: "vendedorEmail", key: "vendedorEmail", width: 24 },
  ];
  sheet.addRow({
    nombre: "Juan",
    apellido: "Pérez",
    edad: 35,
    telefono: "5512345678",
    producto: "Calm Mag",
    cantidad: 1,
    categoria: "Health & Wellness",
    notas: "Interesado en promoción de 3 piezas",
    country: "MX",
    city: "Ciudad de México",
    state: "CDMX",
    zipCode: "01000",
    ip: "",
    internalSku: "PS-SU-MAG-001",
    vendedorEmail: "",
  });
  sheet.getRow(1).font = { bold: true };
  return workbook.xlsx.writeBuffer();
}

module.exports = { parseWorkbookBuffer, validateRow, buildTemplateBuffer, REQUIRED_FIELDS };
