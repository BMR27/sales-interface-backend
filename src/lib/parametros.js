const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Parámetros de operación por empresa. Estaban fijos en el código (la
// comisión en ganancias.js, las metas en dashboard.js, el costo de envío en
// shippingCost.js), así que cambiar cualquiera de ellos requería un deploy.
//
// `min`/`max` no son adorno: son el rango que el PUT valida, para que un
// dedazo no deje la comisión en 1500% ni la meta en negativo.
const DEFINICION = {
  comisionPorcentaje: {
    default: 15,
    min: 0,
    max: 100,
    label: "Comisión del vendedor",
    sufijo: "%",
    ayuda: "Porcentaje sobre el producto vendido. No aplica al costo de envío.",
    grupo: "Comisiones y metas",
  },
  metaMensual: {
    default: 120000,
    min: 0,
    max: 100000000,
    label: "Meta mensual de venta",
    prefijo: "$",
    ayuda: "Objetivo de monto vendido al mes, por vendedor.",
    grupo: "Comisiones y metas",
  },
  metaDiaria: {
    default: 40,
    min: 1,
    max: 1000,
    label: "Meta diaria de ventas",
    sufijo: "ventas",
    ayuda: "Número de ventas al día que se usa para el avance del tablero.",
    grupo: "Comisiones y metas",
  },
  envioUmbralPiezas: {
    default: 3,
    min: 1,
    max: 100,
    label: "Piezas para envío gratis",
    sufijo: "piezas",
    ayuda: "A partir de esta cantidad, el envío no se cobra.",
    grupo: "Costo de envío",
  },
  envioCostoBase: {
    default: 250,
    min: 0,
    max: 100000,
    label: "Costo de envío",
    prefijo: "$",
    ayuda: "Se cobra cuando la compra no llega a las piezas de envío gratis.",
    grupo: "Costo de envío",
  },
  envioFueraCobertura: {
    default: 190,
    min: 0,
    max: 100000,
    label: "Envío fuera de cobertura",
    prefijo: "$",
    ayuda: "Se cobra cuando el domicilio queda fuera de la cobertura de FullVector, sin importar las piezas.",
    grupo: "Costo de envío",
  },
};

const CLAVES = Object.keys(DEFINICION);
const PREFIJO = "parametros.";

function valoresPorDefecto() {
  return Object.fromEntries(CLAVES.map((k) => [k, DEFINICION[k].default]));
}

async function getParametros(tenantId) {
  const valores = valoresPorDefecto();
  if (!tenantId) return valores;

  const filas = await prisma.appSetting.findMany({
    where: { tenantId, key: { in: CLAVES.map((k) => PREFIJO + k) } },
  });

  for (const fila of filas) {
    const clave = fila.key.slice(PREFIJO.length);
    const num = Number(fila.value);
    if (clave in valores && Number.isFinite(num)) valores[clave] = num;
  }
  return valores;
}

// Devuelve { valores, errores }. No escribe nada si algo viene fuera de
// rango: media configuración guardada es peor que ninguna.
async function setParametros(tenantId, entrada) {
  const errores = [];
  const aGuardar = {};

  for (const [clave, valor] of Object.entries(entrada || {})) {
    if (!(clave in DEFINICION)) continue;
    const def = DEFINICION[clave];
    const num = Number(valor);
    if (!Number.isFinite(num)) {
      errores.push(`${def.label}: debe ser un número`);
    } else if (num < def.min || num > def.max) {
      errores.push(`${def.label}: debe estar entre ${def.min} y ${def.max}`);
    } else {
      aGuardar[clave] = num;
    }
  }

  if (errores.length > 0) return { errores };

  for (const [clave, num] of Object.entries(aGuardar)) {
    const key = PREFIJO + clave;
    const existente = await prisma.appSetting.findFirst({ where: { tenantId, key } });
    if (existente) {
      await prisma.appSetting.update({ where: { id: existente.id }, data: { value: String(num) } });
    } else {
      await prisma.appSetting.create({ data: { tenantId, key, value: String(num) } });
    }
  }

  return { valores: await getParametros(tenantId) };
}

// Misma regla de siempre, ahora leyendo los parámetros en vez de constantes.
function calcularCostoEnvio({ cantidadTotal, cobertura }, params) {
  const p = { ...valoresPorDefecto(), ...(params || {}) };
  if (cobertura === false) return p.envioFueraCobertura;
  return cantidadTotal >= p.envioUmbralPiezas ? 0 : p.envioCostoBase;
}

module.exports = {
  DEFINICION,
  CLAVES,
  valoresPorDefecto,
  getParametros,
  setParametros,
  calcularCostoEnvio,
};
