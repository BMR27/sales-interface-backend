// Repetidos y numeros bloqueados.
//
// Dos cosas que la gente junta bajo la palabra "blacklist" y que conviene
// no confundir, porque se resuelven distinto:
//
//   REPETIDOS   el mismo cliente entro dos veces. Se DETECTA comparando la
//               base contra si misma; nadie lo captura. Es un cobro de mas
//               del proveedor y una llamada de mas al cliente.
//   BLOQUEADOS  alguien decidio que a ese numero no se le vuelve a llamar.
//               No se deduce de nada: es una decision registrada, y la
//               ingesta la consulta en cada lead que entra.
//
// Por que la pantalla no descarta leads en masa: un grupo de repetidos no
// siempre es un error. Dos personas de la misma casa comparten telefono, y
// dos clientes distintos se llaman igual. Cerrar automaticamente el
// segundo lead de cada grupo tiraria ventas reales. Aqui se ve y se
// exporta; cerrar un lead sigue pasando por el ciclo de vida de siempre,
// con una persona decidiendo.
const express = require("express");
const ExcelJS = require("exceljs");
const authMiddleware = require("../middleware/auth");
const gestionAdmin = require("../middleware/gestionAdmin");
const { LEAD_STATUS_LABELS } = require("../lib/leadStatus");
const { claveTelefono, claveNombre } = require("../lib/numeroBloqueado");
const { registrar } = require("../lib/auditoria");
const { ROJO, FMT_FECHA, rematar, envolver, colorEstatus } = require("../lib/excelEstilo");

const router = express.Router();
const prisma = require("../lib/prisma");

// Mismo criterio que Leads, Ventas y Reportes.
router.use(authMiddleware, gestionAdmin);

// Tope de grupos que se devuelven. Con mas que esto la pantalla deja de
// ser revisable y lo que se quiere es el Excel.
const MAX_GRUPOS = 300;

// --- Deteccion de repetidos -----------------------------------------
//
// Se agrupa en SQL y no en JavaScript: traer la tabla entera para
// agruparla en memoria funciona con 600 leads y deja de funcionar con
// 60,000, y esta pantalla se va a abrir cuando la base sea grande.
//
// La clave de telefono son los ultimos 10 digitos (right(regexp_replace
// ...)), la misma regla que usa src/lib/numeroBloqueado.js: el mismo
// numero llega escrito de cuatro formas y como texto no casarian. La de
// nombre es minusculas sin espacios de sobra; los acentos no se quitan en
// SQL -- unaccent no siempre esta instalada -- asi que "Lopez" y "López"
// quedan en grupos distintos. Es un falso negativo asumido: separa de
// mas, nunca junta de menos, y lo segundo seria peor.
async function gruposRepetidos(tenantId, criterio) {
  const clave =
    criterio === "nombre"
      ? "lower(regexp_replace(trim(nombre), '\\s+', ' ', 'g'))"
      : "right(regexp_replace(telefono, '[^0-9]', '', 'g'), 10)";

  const filas = await prisma.$queryRawUnsafe(
    `SELECT ${clave} AS clave, COUNT(*)::int AS total
       FROM leads
      WHERE "tenantId" = $1 AND ${criterio === "nombre" ? "nombre" : "telefono"} IS NOT NULL
        AND ${clave} <> ''
      GROUP BY ${clave}
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, MAX("createdAt") DESC
      LIMIT ${MAX_GRUPOS}`,
    tenantId
  );

  if (filas.length === 0) return [];

  // Los leads de esos grupos, de un solo viaje. Se vuelve a calcular la
  // clave en SQL para no depender de que JavaScript la derive igual.
  const claves = filas.map((f) => f.clave);
  const leads = await prisma.$queryRawUnsafe(
    `SELECT id, ${clave} AS clave, "folioPS", folio, nombre, telefono, producto, status,
            "motivoDescarte", "createdAt", "vendedorId", state
       FROM leads
      WHERE "tenantId" = $1 AND ${clave} = ANY($2::text[])
      ORDER BY "createdAt" ASC`,
    tenantId,
    claves
  );

  const porClave = new Map();
  for (const l of leads) {
    if (!porClave.has(l.clave)) porClave.set(l.clave, []);
    porClave.get(l.clave).push(l);
  }

  return filas.map((f) => {
    const miembros = porClave.get(f.clave) || [];
    return {
      clave: f.clave,
      total: f.total,
      // El primero que entro es el que se conserva; los demas son los
      // repetidos. Sin decir cual es cual, la pantalla obliga a comparar
      // fechas a ojo.
      primero: miembros[0] || null,
      leads: miembros,
      // Mismo telefono con nombres distintos no es lo mismo que el mismo
      // cliente dos veces: puede ser una familia, o datos inventados. Se
      // marca para que se revise en vez de cerrarlo de corrido.
      // Con la MISMA normalizacion que el agrupado por nombre: con una mas
      // pobre, "Ana Ruiz" y "ANA  RUIZ" salian como personas distintas y
      // el aviso aparecia en grupos donde no tocaba.
      nombresDistintos:
        criterio === "telefono"
          ? new Set(miembros.map((m) => claveNombre(m.nombre))).size > 1
          : false,
      yaDescartados: miembros.filter((m) => m.motivoDescarte === "DUPLICADO").length,
    };
  });
}

// GET /api/admin/blacklist/repetidos?criterio=telefono|nombre
router.get("/repetidos", async (req, res) => {
  try {
    const criterio = req.query.criterio === "nombre" ? "nombre" : "telefono";
    const grupos = await gruposRepetidos(req.user.tenantId, criterio);
    res.json({
      criterio,
      grupos,
      resumen: {
        grupos: grupos.length,
        leads: grupos.reduce((a, g) => a + g.total, 0),
        // Lo que de verdad importa: cuantos leads sobran. Un grupo de 4 es
        // 1 bueno y 3 de mas.
        repetidos: grupos.reduce((a, g) => a + (g.total - 1), 0),
        yaDescartados: grupos.reduce((a, g) => a + g.yaDescartados, 0),
      },
      truncado: grupos.length >= MAX_GRUPOS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/admin/blacklist/repetidos/export?criterio=telefono|nombre
router.get("/repetidos/export", async (req, res) => {
  try {
    const criterio = req.query.criterio === "nombre" ? "nombre" : "telefono";
    const grupos = await gruposRepetidos(req.user.tenantId, criterio);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Perfect Sales";
    wb.created = new Date();

    const sheet = wb.addWorksheet(criterio === "nombre" ? "Nombre repetido" : "Teléfono repetido");
    sheet.columns = [
      { header: "Grupo", key: "grupo", width: 8 },
      { header: criterio === "nombre" ? "Nombre" : "Teléfono", key: "clave", width: 24 },
      { header: "Veces", key: "veces", width: 8 },
      { header: "¿Es el primero?", key: "primero", width: 15 },
      { header: "Folio PS", key: "folioPS", width: 13 },
      { header: "Folio proveedor", key: "folio", width: 16 },
      { header: "Entró", key: "createdAt", width: 17 },
      { header: "Cliente", key: "nombre", width: 26 },
      { header: "Teléfono", key: "telefono", width: 16 },
      { header: "Producto", key: "producto", width: 22 },
      { header: "Estatus", key: "estatus", width: 16 },
      { header: "¿Ya marcado duplicado?", key: "yaDup", width: 21 },
      { header: "Estado", key: "state", width: 18 },
      { header: "Aviso", key: "aviso", width: 44 },
    ];

    let n = 0;
    for (const g of grupos) {
      n += 1;
      for (const [i, l] of g.leads.entries()) {
        const fila = sheet.addRow({
          grupo: n,
          clave: g.clave,
          veces: g.total,
          primero: i === 0 ? "Sí — conservar" : "No — repetido",
          folioPS: l.folioPS || "",
          folio: l.folio || "",
          createdAt: l.createdAt,
          nombre: l.nombre,
          telefono: l.telefono,
          producto: l.producto,
          estatus: LEAD_STATUS_LABELS[l.status] || l.status,
          yaDup: l.motivoDescarte === "DUPLICADO" ? "Sí" : "No",
          state: l.state || "",
          aviso: g.nombresDistintos
            ? "Mismo teléfono con nombres distintos: puede ser otra persona de la misma casa."
            : "",
        });
        fila.getCell("createdAt").numFmt = FMT_FECHA;
        fila.getCell("telefono").numFmt = "@";
        envolver(fila, ["aviso"]);
        fila.getCell("estatus").font = { bold: true, color: { argb: colorEstatus(l.status) } };
        if (i > 0) fila.getCell("primero").font = { bold: true, color: { argb: ROJO } };
      }
    }

    rematar(sheet);
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="repetidos_por_${criterio}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// --- Numeros bloqueados ---------------------------------------------

// GET /api/admin/blacklist/bloqueados
router.get("/bloqueados", async (req, res) => {
  try {
    const bloqueados = await prisma.numeroBloqueado.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { createdAt: "desc" },
      include: { creadoPor: { select: { nombre: true } } },
    });
    res.json({ bloqueados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/admin/blacklist/bloqueados  { telefono, motivo, nota }
router.post("/bloqueados", async (req, res) => {
  try {
    const { telefono, motivo, nota } = req.body || {};
    const clave = claveTelefono(telefono);

    // Diez digitos es el largo nacional. Menos que eso casi siempre es un
    // dedazo, y bloquear "55" dejaria fuera a medio pais.
    if (clave.length < 10) {
      return res.status(400).json({ error: "El teléfono debe traer al menos 10 dígitos" });
    }
    if (!motivo || !String(motivo).trim()) {
      return res.status(400).json({ error: "Escribe por qué se bloquea este número" });
    }

    const existente = await prisma.numeroBloqueado.findUnique({
      where: { tenantId_telefono: { tenantId: req.user.tenantId, telefono: clave } },
    });
    if (existente) {
      return res.status(409).json({ error: "Ese número ya está en la lista" });
    }

    const creado = await prisma.numeroBloqueado.create({
      data: {
        telefono: clave,
        telefonoOriginal: String(telefono).trim().slice(0, 40),
        motivo: String(motivo).trim().slice(0, 200),
        nota: nota ? String(nota).trim().slice(0, 500) : null,
        creadoPorId: req.user.id,
        tenantId: req.user.tenantId,
      },
    });

    // Bloquear un numero decide que a una persona no se le vuelve a
    // llamar: tiene que quedar registrado quien lo hizo.
    await registrar({
      tenantId: req.user.tenantId,
      userId: req.user.id,
      userEmail: req.user.email,
      userRol: req.user.rol,
      accion: "blacklist.agregar",
      entidad: "Número bloqueado",
      entidadId: creado.id,
      descripcion: `Bloqueó el número ${clave}`,
      metodo: "POST",
      ruta: "/api/admin/blacklist/bloqueados",
    });

    res.status(201).json({ bloqueado: creado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// DELETE /api/admin/blacklist/bloqueados/:id
router.delete("/bloqueados/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = await prisma.numeroBloqueado.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!b) return res.status(404).json({ error: "No se encontró ese número en la lista" });

    await prisma.numeroBloqueado.delete({ where: { id } });
    await registrar({
      tenantId: req.user.tenantId,
      userId: req.user.id,
      userEmail: req.user.email,
      userRol: req.user.rol,
      accion: "blacklist.quitar",
      entidad: "Número bloqueado",
      entidadId: id,
      descripcion: `Quitó de la lista el número ${b.telefono}`,
      metodo: "DELETE",
      ruta: "/api/admin/blacklist/bloqueados/:id",
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
