const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Parámetros de operación por empresa. Estaban fijos en el código (la
// comisión en ganancias.js, las metas en dashboard.js, el costo de envío en
// shippingCost.js), así que cambiar cualquiera de ellos requería un deploy.
//
// `min`/`max` no son adorno: son el rango que el PUT valida, para que un
// dedazo no deje la comisión en 1500% ni la meta en negativo.
const DEFINICION = {
  asignacionAutomatica: {
    tipo: "boolean",
    default: false,
    label: "Asignar leads automáticamente",
    ayuda:
      "Apagado, los leads que llegan por la API entran sin vendedora y esperan en la cola del coordinador. Encendido, se reparten solos por turnos entre las vendedoras activas.",
    grupo: "Asignación de leads",
  },
  // Grabar llamadas nace apagado a proposito: es una decision legal de cada
  // empresa (aviso de privacidad, consentimiento del cliente, cuanto tiempo
  // se conserva el audio), no algo que el sistema deba dar por hecho.
  grabacionLlamadas: {
    tipo: "boolean",
    default: false,
    label: "Grabar las llamadas",
    ayuda:
      "Guarda el audio de cada llamada para que el administrador pueda escucharlo despues. Antes de encenderlo asegurate de que tu aviso de privacidad lo contemple: grabar sin informar al cliente te expone.",
    grupo: "Llamadas",
  },
  grabacionAvisoCliente: {
    tipo: "boolean",
    default: true,
    label: "Avisar al cliente que se graba",
    ayuda:
      "Reproduce un aviso al inicio de la llamada antes de marcar. Apagarlo solo tiene sentido si ya obtienes el consentimiento por otra via; la carga de probarlo es tuya.",
    grupo: "Llamadas",
  },
  comisionPorcentaje: {
    default: 15,
    min: 0,
    max: 100,
    label: "Comisión del vendedor",
    sufijo: "%",
    ayuda: "Porcentaje sobre el producto vendido. No aplica al costo de envío.",
    grupo: "Comisiones y metas",
  },
  comisionBloquePiezas: {
    default: 3,
    min: 1,
    max: 100,
    label: "Piezas por bloque de comision",
    sufijo: "piezas",
    ayuda:
      "Cada bloque completo de piezas pagadas paga la comision del bloque. La pieza de regalo del 3+1 no cuenta.",
    grupo: "Comisiones y metas",
  },
  comisionBloqueMonto: {
    default: 40,
    min: 0,
    max: 100000,
    label: "Comision por bloque",
    prefijo: "$",
    ayuda:
      "Importe fijo que gana la vendedora por cada bloque completo de piezas acumuladas en la quincena.",
    grupo: "Comisiones y metas",
  },
  comisionCoordinadoraPorVenta: {
    default: 12,
    min: 0,
    max: 100000,
    label: "Comision de coordinadora por venta",
    prefijo: "$",
    ayuda: "Se paga por cada venta valida, sin importar cuantas piezas lleve.",
    grupo: "Comisiones y metas",
  },
  metaDiariaUnidades: {
    default: 6,
    min: 1,
    max: 1000,
    label: "Meta diaria de piezas",
    sufijo: "piezas",
    ayuda: "Indicador de productividad. No condiciona el pago de la comision.",
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

function esBooleano(clave) {
  return DEFINICION[clave]?.tipo === "boolean";
}

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
    if (!(clave in valores)) continue;
    if (esBooleano(clave)) {
      valores[clave] = fila.value === "true";
    } else {
      const num = Number(fila.value);
      if (Number.isFinite(num)) valores[clave] = num;
    }
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

    if (esBooleano(clave)) {
      aGuardar[clave] = Boolean(valor);
      continue;
    }

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
  esBooleano,
  CLAVES,
  valoresPorDefecto,
  getParametros,
  setParametros,
  calcularCostoEnvio,
};
