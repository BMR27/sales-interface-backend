// Avisos que no nacen de un evento sino de los números de la persona:
// el avance de la meta del día, los bloques de comisión de la quincena, la
// cola que se está acumulando, el stock que se está acabando.
//
// Se recalculan cada vez que alguien abre la campana en vez de correr en un
// cron. El antiduplicado no es una bandera en memoria sino la clave única de
// `Notificacion` (ver avisos.js): si el hito ya se avisó hoy, el insert se
// descarta solo. Eso lo hace seguro aunque haya varias instancias del
// servidor y aunque la persona recargue diez veces.
const { LEAD_STATUSES_ABIERTOS } = require("./leadStatus");
const { getParametros } = require("./parametros");
const { calcularQuincenaVendedora, calcularQuincenaCoordinadoras } = require("./comisiones");
const { claveDia, crearAvisoUnico } = require("./avisos");
const { inicioDeHoy } = require("./fechasLocales");
const { frasePara } = require("./motivacion");

const prisma = require("./prisma");

const dinero = (n) => `$${Math.round(n || 0).toLocaleString("es-MX")}`;
const plural = (n, singular, pluralForma) => `${n} ${n === 1 ? singular : pluralForma}`;

// --- Vendedora ---

async function avisosVendedora(user) {
  const dia = claveDia();
  // `claveDia` ya resolvia el dia en hora de Mexico, pero la ventana con la
  // que se consultaban los numeros no: con setHours(0,0,0,0) en un servidor
  // UTC, el aviso decia "hoy" y contaba desde las 18:00 del dia anterior.
  const hoy = inicioDeHoy();
  const base = { userId: user.id, tenantId: user.tenantId ?? null };

  const [ventasHoy, pendientes, params, quincena] = await Promise.all([
    prisma.venta.count({ where: { vendedorId: user.id, fecha: { gte: hoy } } }),
    prisma.lead.count({ where: { vendedorId: user.id, status: { in: LEAD_STATUSES_ABIERTOS } } }),
    getParametros(user.tenantId),
    calcularQuincenaVendedora(user.tenantId, user.id, new Date()).catch(() => null),
  ]);

  const meta = params.metaDiaria || 0;
  const avance = meta > 0 ? ventasHoy / meta : 0;

  // Los cortes de la meta del día. Se emite sólo el más alto que se haya
  // cruzado: quien pasa de 0 a la meta en una racha no necesita además que
  // le avisen que va a la mitad, y ese aviso tardío leería "te faltan 0
  // ventas". Los cortes bajos siguen sirviendo para quien sube de a poco,
  // porque cada uno tiene su propia clave del día.
  const cortes = [
    { pct: 1, clave: "meta-100", titulo: "¡Meta del día cumplida!", categoria: "LOGRO" },
    { pct: 0.8, clave: "meta-80", titulo: "Estás cerca de tu meta", categoria: "INFO" },
    { pct: 0.5, clave: "meta-50", titulo: "Vas a la mitad de tu meta", categoria: "INFO" },
  ];
  const corte = cortes.find((c) => avance >= c.pct);
  if (corte) {
    const faltan = Math.max(meta - ventasHoy, 0);
    await crearAvisoUnico({
      ...base,
      clave: `${corte.clave}-${dia}`,
      tipo: "meta.progreso",
      categoria: corte.categoria,
      titulo: corte.titulo,
      mensaje:
        corte.pct === 1
          ? `Llevas ${plural(ventasHoy, "venta", "ventas")} hoy y la meta eran ${meta}. Lo que cierres de aquí en adelante es extra.`
          : `Llevas ${ventasHoy} de ${meta} ventas. Te ${faltan === 1 ? "falta" : "faltan"} ${plural(faltan, "venta", "ventas")}.`,
      enlace: "/ganancias",
    });
  }

  if (quincena) {
    // Un bloque cerrado es dinero ya ganado: se avisa cada vez que sube el
    // contador, con la clave amarrada al número de bloques para que el
    // bloque 3 no reviva el aviso del bloque 2.
    if (quincena.bloques > 0) {
      await crearAvisoUnico({
        ...base,
        clave: `bloque-${quincena.quincena.clave}-${quincena.bloques}`,
        tipo: "comision.bloque",
        categoria: "EXITO",
        titulo:
          quincena.bloques === 1
            ? "Cerraste tu primer bloque de comisión"
            : `Llevas ${quincena.bloques} bloques de comisión`,
        mensaje: `${plural(quincena.piezas, "pieza pagada", "piezas pagadas")} en la quincena ${quincena.quincena.etiqueta}. Comisión acumulada: ${dinero(quincena.comision)}.`,
        enlace: "/ganancias",
      });
    }

    // "Te falta una pieza" es el aviso más accionable del día; se permite
    // uno diario por cada nivel de bloque alcanzado.
    const faltanPiezas = quincena.sobrantes === 0 ? quincena.porBloque : quincena.porBloque - quincena.sobrantes;
    if (quincena.sobrantes > 0 && faltanPiezas <= 1) {
      await crearAvisoUnico({
        ...base,
        clave: `casi-bloque-${quincena.quincena.clave}-${quincena.bloques}-${dia}`,
        tipo: "comision.casi",
        categoria: "MOTIVACION",
        titulo: "Te falta una pieza para cobrar otro bloque",
        mensaje: `Con una pieza pagada más se te abonan ${dinero(quincena.importeBloque)}. Llevas ${quincena.piezas} en la quincena.`,
        enlace: "/ganancias",
      });
    }
  }

  // La frase del día. La semilla amarra la elección a la persona, al día y a
  // su momento de avance: estable si recarga, distinta mañana.
  const piezasParaBloque = quincena
    ? quincena.sobrantes === 0
      ? quincena.porBloque
      : quincena.porBloque - quincena.sobrantes
    : null;
  const frase = frasePara(
    {
      nombre: user.nombre,
      ventas: ventasHoy,
      meta,
      piezas: quincena?.piezas ?? 0,
      piezasParaBloque,
      comision: quincena?.comision ?? 0,
    },
    `${user.id}-${dia}`,
  );
  // Una frase por momento del día, no una por consulta: la clave lleva el
  // grupo, así que sólo aparece otra cuando su avance cambió de tramo. El
  // título cambia con el tramo para que dos frases del mismo día no se vean
  // como el mismo aviso repetido.
  const TITULO_MOTIVACION = {
    arranque: "Arranca el día",
    caminando: "Vas avanzando",
    mitad: "Vas a buen ritmo",
    cerca: "Ya casi",
    meta: "Gran día",
    bloque: "Estás a una pieza",
  };
  await crearAvisoUnico({
    ...base,
    clave: `motivacion-${dia}-${frase.grupo}`,
    tipo: "motivacion",
    categoria: "MOTIVACION",
    titulo: TITULO_MOTIVACION[frase.grupo] || "Para tu día",
    mensaje: frase.mensaje,
    enlace: "/leads",
  });

  // Una cola llena que nadie trabaja es la causa más común de un mal día.
  if (pendientes >= 10) {
    await crearAvisoUnico({
      ...base,
      clave: `cola-propia-${dia}`,
      tipo: "leads.cola",
      categoria: "INFO",
      titulo: "Tienes leads esperando",
      mensaje: `${plural(pendientes, "lead pendiente", "leads pendientes")} en tu cola. Cada uno es una venta posible.`,
      enlace: "/leads",
    });
  }
}

// --- Coordinadora ---

async function avisosCoordinadora(user) {
  const dia = claveDia();
  // `claveDia` ya resolvia el dia en hora de Mexico, pero la ventana con la
  // que se consultaban los numeros no: con setHours(0,0,0,0) en un servidor
  // UTC, el aviso decia "hoy" y contaba desde las 18:00 del dia anterior.
  const hoy = inicioDeHoy();
  const base = { userId: user.id, tenantId: user.tenantId ?? null };

  const [sinAsignar, ventasHoy, comisiones] = await Promise.all([
    prisma.lead.count({ where: { tenantId: user.tenantId, vendedorId: null, status: { in: LEAD_STATUSES_ABIERTOS } } }),
    prisma.venta.count({ where: { tenantId: user.tenantId, fecha: { gte: hoy } } }),
    calcularQuincenaCoordinadoras(user.tenantId, new Date()).catch(() => null),
  ]);

  if (sinAsignar > 0) {
    // Por tramos: avisar "hay 1 lead en cola" todos los días sería ruido,
    // pero 50 sin repartir sí merece interrumpir.
    const tramo = sinAsignar >= 50 ? 50 : sinAsignar >= 20 ? 20 : sinAsignar >= 5 ? 5 : null;
    if (tramo) {
      await crearAvisoUnico({
        ...base,
        clave: `cola-sin-asignar-${tramo}-${dia}`,
        tipo: "leads.sin_asignar",
        categoria: sinAsignar >= 50 ? "ALERTA" : "INFO",
        titulo: "Hay leads sin asignar",
        mensaje: `${plural(sinAsignar, "lead espera", "leads esperan")} en la cola. Repártelos para que no se enfríen.`,
        enlace: "/coordinador/leads",
      });
    }
  }

  const mia = comisiones?.coordinadoras.find((c) => c.id === user.id);
  if (mia && mia.comision > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `coord-comision-${comisiones.quincena.clave}-${dia}`,
      tipo: "comision.resumen",
      categoria: "INFO",
      titulo: "Tu comisión de la quincena",
      mensaje: `Llevas ${dinero(mia.comision)} por ${plural(Math.round(mia.ventas), "venta asignada", "ventas asignadas")} en ${comisiones.quincena.etiqueta}.`,
      enlace: "/coordinador/progreso",
    });
  }

  if (ventasHoy > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `coord-ventas-dia-${dia}`,
      tipo: "ventas.resumen",
      categoria: "EXITO",
      titulo: "El equipo va cerrando",
      mensaje: `${plural(ventasHoy, "venta cerrada", "ventas cerradas")} hoy por tu equipo.`,
      enlace: "/coordinador/progreso",
    });
  }
}

// --- Admin ---

async function avisosAdmin(user) {
  const dia = claveDia();
  // `claveDia` ya resolvia el dia en hora de Mexico, pero la ventana con la
  // que se consultaban los numeros no: con setHours(0,0,0,0) en un servidor
  // UTC, el aviso decia "hoy" y contaba desde las 18:00 del dia anterior.
  const hoy = inicioDeHoy();
  const base = { userId: user.id, tenantId: user.tenantId ?? null };

  const [sinAsignar, ventasHoy, fallidas, prepagosPendientes, stockBajo] = await Promise.all([
    prisma.lead.count({ where: { tenantId: user.tenantId, vendedorId: null, status: { in: LEAD_STATUSES_ABIERTOS } } }),
    prisma.venta.aggregate({
      where: { tenantId: user.tenantId, fecha: { gte: hoy } },
      _count: true,
      _sum: { monto: true },
    }),
    prisma.venta.count({ where: { tenantId: user.tenantId, fullvectorSyncStatus: "FAILED" } }),
    prisma.prepagoGestion.count({
      where: { tenantId: user.tenantId, estado: { in: ["PENDIENTE_CONTACTO", "TRANSFERENCIA_OFRECIDA"] } },
    }),
    prisma.producto.count({ where: { tenantId: user.tenantId, activo: true, stock: { lte: 5 } } }),
  ]);

  if (ventasHoy._count > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `admin-ventas-dia-${dia}`,
      tipo: "ventas.resumen",
      categoria: "EXITO",
      titulo: "Ventas del día",
      mensaje: `${plural(ventasHoy._count, "venta", "ventas")} por ${dinero(ventasHoy._sum.monto)} en lo que va del día.`,
      enlace: "/admin/ventas",
    });
  }

  if (sinAsignar >= 5) {
    await crearAvisoUnico({
      ...base,
      clave: `admin-cola-${sinAsignar >= 50 ? 50 : sinAsignar >= 20 ? 20 : 5}-${dia}`,
      tipo: "leads.sin_asignar",
      categoria: sinAsignar >= 50 ? "ALERTA" : "INFO",
      titulo: "Leads sin asignar",
      mensaje: `${plural(sinAsignar, "lead sigue", "leads siguen")} sin vendedora asignada.`,
      enlace: "/admin/leads",
    });
  }

  if (fallidas > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `admin-sync-${dia}`,
      tipo: "ventas.sin_sincronizar",
      categoria: "ALERTA",
      titulo: "Ventas sin sincronizar",
      mensaje: `${plural(fallidas, "venta no pudo", "ventas no pudieron")} enviarse a FullVector. Revísalas antes de que se acumulen.`,
      enlace: "/admin/ventas",
    });
  }

  if (prepagosPendientes > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `admin-prepago-${dia}`,
      tipo: "prepago.pendiente",
      categoria: "ALERTA",
      titulo: "Prepagos por cobrar",
      mensaje: `${plural(prepagosPendientes, "venta fuera de cobertura espera", "ventas fuera de cobertura esperan")} cobro por transferencia.`,
      enlace: "/prepago",
    });
  }

  if (stockBajo > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `admin-stock-${dia}`,
      tipo: "inventario.bajo",
      categoria: "ALERTA",
      titulo: "Inventario bajo",
      mensaje: `${plural(stockBajo, "producto tiene", "productos tienen")} 5 piezas o menos en existencia.`,
      enlace: "/admin/inventario",
    });
  }
}

// --- Proveedor de leads ---

async function avisosProveedor(user) {
  const dia = claveDia();
  // `claveDia` ya resolvia el dia en hora de Mexico, pero la ventana con la
  // que se consultaban los numeros no: con setHours(0,0,0,0) en un servidor
  // UTC, el aviso decia "hoy" y contaba desde las 18:00 del dia anterior.
  const hoy = inicioDeHoy();
  const base = { userId: user.id, tenantId: user.tenantId ?? null };

  // Los leads del proveedor son los que entraron por sus propias API keys;
  // sin keys no hay nada que resumirle.
  const keys = await prisma.apiKey.findMany({
    where: { createdByUserId: user.id, tenantId: user.tenantId },
    select: { id: true },
  });
  if (keys.length === 0) return;
  const apiKeyId = { in: keys.map((k) => k.id) };

  const [entregadosHoy, rechazadosHoy] = await Promise.all([
    prisma.incomingLead.count({ where: { apiKeyId, createdAt: { gte: hoy }, status: "ASSIGNED" } }),
    prisma.incomingLead.count({ where: { apiKeyId, createdAt: { gte: hoy }, status: "FAILED" } }),
  ]);

  if (entregadosHoy > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `proveedor-entregados-${dia}`,
      tipo: "leads.entregados",
      categoria: "EXITO",
      titulo: "Leads entregados hoy",
      mensaje: `${plural(entregadosHoy, "lead tuyo entró", "leads tuyos entraron")} al sistema hoy.`,
      enlace: "/proveedor",
    });
  }

  if (rechazadosHoy > 0) {
    await crearAvisoUnico({
      ...base,
      clave: `proveedor-rechazados-${dia}`,
      tipo: "leads.rechazados",
      categoria: "ALERTA",
      titulo: "Leads que no entraron",
      mensaje: `${plural(rechazadosHoy, "lead tuyo falló", "leads tuyos fallaron")} hoy al procesarse. Revisa el formato o los duplicados.`,
      enlace: "/proveedor",
    });
  }
}

// Punto de entrada: corre el generador que le toca al rol. Nunca lanza --
// si el cálculo falla, la campana debe seguir mostrando lo que ya había.
async function sincronizarAvisos(user) {
  if (!user?.id || !user.tenantId) return;
  try {
    if (user.rol === "VENDEDOR") await avisosVendedora(user);
    else if (user.rol === "COORDINADOR") await avisosCoordinadora(user);
    else if (user.rol === "ADMIN") await avisosAdmin(user);
    else if (user.rol === "PROVEEDOR_LEADS") await avisosProveedor(user);
  } catch (err) {
    console.error("sincronizarAvisos falló para", user.id, user.rol, err);
  }
}

module.exports = { sincronizarAvisos };
