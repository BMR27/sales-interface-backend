// Cuánto se gasta en Twilio y cuánto queda de lo recargado.
//
// Es INFORMATIVO, a propósito: el saldo real vive en Twilio y la cuenta es
// compartida con otros negocios, así que su saldo no dice cuánto gasta
// este espacio. Aquí se calcula con los registros propios -- cada llamada
// con su duración, cada SMS/WhatsApp, cada grabación -- por las tarifas
// configuradas, y se resta de las recargas.
//
// Las tarifas son FIJAS y no se editan desde la pantalla: son el costo que
// la empresa decidió cargar por cada acción. Parten de lo que Twilio le
// cobró de verdad a la cuenta (consultado contra su API en noviembre de
// 2026) con un margen encima -- mayor en las grabaciones --, en dólares:
//
//                 Twilio real      tarifa
//   llamada       0.020 /min   ->  0.032 /min   (cobra el minuto completo)
//   SMS           0.1819 /seg  ->  0.28 /segmento
//   WhatsApp      0.0085 /msj  ->  0.014 /mensaje
//   grabación     0.0025 /min  ->  0.014 /minuto grabado
//   almacenaje    0.0005 /min  ->  0.0035 /minuto guardado al mes
//
// Lo único que se mueve es el tipo de cambio, que se consulta solo una vez
// al día (ver src/lib/tipoCambio.js).
const prisma = require("./prisma");
const { obtenerTipoCambio } = require("./tipoCambio");

const TARIFAS = Object.freeze({
  llamadaMinutoUsd: 0.032,
  smsSegmentoUsd: 0.28,
  whatsappMensajeUsd: 0.014,
  grabacionMinutoUsd: 0.014,
  almacenamientoMinutoMesUsd: 0.0035,
});

async function getTarifas() {
  const tc = await obtenerTipoCambio();
  return { ...TARIFAS, tipoCambio: tc.valor, tipoCambioInfo: tc };
}

const minutosFacturados = (seg) => (seg > 0 ? Math.ceil(seg / 60) : 0);
const DIA_MS = 24 * 60 * 60 * 1000;

// Todo lo que costó algo entre `desde` y `hasta`, por persona.
// `vendedorId` limita a una sola persona (para el filtro de la pantalla).
async function gastoEntre(tenantId, desde, hasta, tarifas, { vendedorId = null } = {}) {
  const porUsuario = vendedorId ? { vendedorId } : {};
  const [llamadas, mensajes, grabaciones] = await Promise.all([
    prisma.llamada.findMany({
      where: { tenantId, fecha: { gte: desde, lte: hasta }, duracion: { gt: 0 }, ...porUsuario },
      select: { vendedorId: true, duracion: true },
    }),
    prisma.mensajeEnviado.findMany({
      where: { tenantId, createdAt: { gte: desde, lte: hasta }, ...(vendedorId ? { userId: vendedorId } : {}) },
      select: { userId: true, canal: true, segmentos: true, motivo: true },
    }),
    // Las que estuvieron guardadas en algún momento del periodo.
    prisma.grabacionLlamada.findMany({
      where: { tenantId, duracion: { gt: 0 }, createdAt: { lte: hasta }, estado: { in: ["COMPLETADA", "BORRADA"] }, ...porUsuario },
      select: { vendedorId: true, duracion: true, createdAt: true, estado: true, grabadaAt: true },
    }),
  ]);

  const personas = new Map();
  const de = (id) => {
    const k = id ?? 0;
    if (!personas.has(k)) {
      personas.set(k, {
        userId: id ?? null, llamadas: 0, segundos: 0, minutos: 0, costoLlamadasUsd: 0,
        sms: 0, smsSegmentos: 0, whatsapp: 0, costoMensajesUsd: 0,
        grabaciones: 0, minutosGrabados: 0, costoGrabacionesUsd: 0,
      });
    }
    return personas.get(k);
  };

  for (const l of llamadas) {
    const p = de(l.vendedorId);
    const m = minutosFacturados(l.duracion);
    p.llamadas += 1;
    p.segundos += l.duracion;
    p.minutos += m;
    p.costoLlamadasUsd += m * tarifas.llamadaMinutoUsd;
  }
  const porMotivo = {};
  for (const msg of mensajes) {
    const p = de(msg.userId);
    const costo = msg.canal === "whatsapp" ? tarifas.whatsappMensajeUsd : msg.segmentos * tarifas.smsSegmentoUsd;
    if (msg.canal === "whatsapp") p.whatsapp += 1;
    else { p.sms += 1; p.smsSegmentos += msg.segmentos; }
    p.costoMensajesUsd += costo;
    const k = `${msg.canal}:${msg.motivo}`;
    porMotivo[k] = porMotivo[k] || { canal: msg.canal, motivo: msg.motivo, cantidad: 0, costoUsd: 0 };
    porMotivo[k].cantidad += 1;
    porMotivo[k].costoUsd += costo;
  }
  for (const g of grabaciones) {
    const p = de(g.vendedorId);
    const m = minutosFacturados(g.duracion);
    const grabada = g.grabadaAt || g.createdAt;
    // El minuto grabado se cobra una vez, cuando se graba.
    if (grabada >= desde && grabada <= hasta) {
      p.grabaciones += 1;
      p.minutosGrabados += m;
      p.costoGrabacionesUsd += m * tarifas.grabacionMinutoUsd;
    }
    // El almacenaje, por los días que estuvo guardada dentro del periodo.
    // Se borran a los 15 días; las BORRADAS se cuentan hasta ese plazo.
    const finGuardada = g.estado === "BORRADA" ? new Date(grabada.getTime() + 15 * DIA_MS) : hasta;
    const dias = Math.max(0, (Math.min(finGuardada, hasta) - Math.max(grabada, desde)) / DIA_MS);
    p.costoGrabacionesUsd += m * tarifas.almacenamientoMinutoMesUsd * (dias / 30);
  }

  const filas = [...personas.values()].map((p) => ({
    ...p,
    totalUsd: p.costoLlamadasUsd + p.costoMensajesUsd + p.costoGrabacionesUsd,
  }));
  const suma = (k) => filas.reduce((a, f) => a + f[k], 0);
  return {
    personas: filas,
    porMotivo: Object.values(porMotivo),
    totales: {
      llamadas: suma("llamadas"), segundos: suma("segundos"), minutos: suma("minutos"),
      costoLlamadasUsd: suma("costoLlamadasUsd"),
      sms: suma("sms"), smsSegmentos: suma("smsSegmentos"), whatsapp: suma("whatsapp"),
      costoMensajesUsd: suma("costoMensajesUsd"),
      grabaciones: suma("grabaciones"), minutosGrabados: suma("minutosGrabados"),
      costoGrabacionesUsd: suma("costoGrabacionesUsd"),
      totalUsd: suma("totalUsd"),
    },
  };
}

// El resumen de la pantalla: gasto del periodo filtrado y el saldo
// estimado (todas las recargas menos todo lo gastado desde la primera).
async function resumenGastos(tenantId, { desde, hasta, vendedorId = null }) {
  const tarifas = await getTarifas();
  const recargas = await prisma.recargaTwilio.findMany({ where: { tenantId }, orderBy: { fecha: "desc" } });
  const aMxn = (usd) => usd * tarifas.tipoCambio;

  const periodo = await gastoEntre(tenantId, desde, hasta, tarifas, { vendedorId });

  // El saldo no depende del filtro: desde la primera recarga hasta ahora.
  let saldo = null;
  if (recargas.length > 0) {
    const primera = recargas[recargas.length - 1].fecha;
    const todo = await gastoEntre(tenantId, primera, new Date(), tarifas);
    const recargado = recargas.reduce((a, r) => a + r.monto, 0);
    const gastado = aMxn(todo.totales.totalUsd);
    const dias = Math.max(1, (Date.now() - primera.getTime()) / DIA_MS);
    const porDia = gastado / dias;
    saldo = {
      recargado,
      gastado,
      restante: recargado - gastado,
      desde: primera,
      gastoPorDia: porDia,
      // A este ritmo, cuántos días alcanza lo que queda.
      diasRestantes: porDia > 0 ? Math.max(0, (recargado - gastado) / porDia) : null,
    };
  }

  const usuarios = await prisma.user.findMany({
    where: { tenantId, id: { in: periodo.personas.map((p) => p.userId).filter(Boolean) } },
    select: { id: true, nombre: true, rol: true, activo: true },
  });
  const porId = new Map(usuarios.map((u) => [u.id, u]));
  const t = periodo.totales;
  return {
    tarifas,
    saldo,
    recargas,
    periodo: {
      desde, hasta,
      totales: {
        ...t,
        costoLlamadas: aMxn(t.costoLlamadasUsd),
        costoMensajes: aMxn(t.costoMensajesUsd),
        costoGrabaciones: aMxn(t.costoGrabacionesUsd),
        total: aMxn(t.totalUsd),
        // El promedio que pidió operación: cuánto cuesta en promedio una
        // llamada y cuántos segundos dura.
        promedioSegundos: t.llamadas ? t.segundos / t.llamadas : 0,
        costoPromedioLlamada: t.llamadas ? aMxn(t.costoLlamadasUsd) / t.llamadas : 0,
        costoPorSegundo: t.segundos ? aMxn(t.costoLlamadasUsd) / t.segundos : 0,
      },
      porMotivo: periodo.porMotivo.map((m) => ({ ...m, costo: aMxn(m.costoUsd) })),
      // Las dadas de baja no salen en ninguna lista; su gasto sí cuenta en
      // los totales.
      porPersona: periodo.personas
        .filter((p) => p.userId && porId.get(p.userId)?.activo)
        .map((p) => ({
          ...p,
          nombre: porId.get(p.userId).nombre,
          rol: porId.get(p.userId).rol,
          costoLlamadas: aMxn(p.costoLlamadasUsd),
          costoMensajes: aMxn(p.costoMensajesUsd),
          costoGrabaciones: aMxn(p.costoGrabacionesUsd),
          total: aMxn(p.totalUsd),
          promedioSegundos: p.llamadas ? p.segundos / p.llamadas : 0,
        }))
        .sort((a, b) => b.total - a.total),
    },
  };
}

module.exports = { TARIFAS, getTarifas, resumenGastos, gastoEntre };
