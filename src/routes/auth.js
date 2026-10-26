const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const authMiddleware = require("../middleware/auth");

const { detallarMovimiento, registrar } = require("../lib/auditoria");
const {
  DURACION_HORAS,
  sesionActivaDe,
  crearSesion,
  revocarSesiones,
} = require("../lib/sesiones");
const { crearAvisoUnico } = require("../lib/avisos");
const { bienvenida } = require("../lib/motivacion");
const { getParametros } = require("../lib/parametros");
const { LEAD_STATUSES_ABIERTOS } = require("../lib/leadStatus");

const router = express.Router();
const prisma = require("../lib/prisma");

// El saludo al entrar. Para la vendedora lleva sus números del momento
// (meta del día, leads en cola); para los demás roles es sólo el saludo.
// Se crea con clave de sesión para que entrar dos veces el mismo día deje
// dos saludos y no uno pegado, pero sin repetirlo si recarga.
async function saludar(user, sesionId) {
  try {
    let meta = 0;
    let pendientes = 0;
    if (user.rol === "VENDEDOR" && user.tenantId) {
      const [params, cola] = await Promise.all([
        getParametros(user.tenantId),
        prisma.lead.count({ where: { vendedorId: user.id, status: { in: LEAD_STATUSES_ABIERTOS } } }),
      ]);
      meta = params.metaDiaria || 0;
      pendientes = cola;
    }

    await crearAvisoUnico({
      userId: user.id,
      tenantId: user.tenantId ?? null,
      clave: `bienvenida-${sesionId}`,
      tipo: "bienvenida",
      categoria: "MOTIVACION",
      titulo: `¡Hola, ${(user.nombre || "").split(" ")[0]}!`,
      mensaje: bienvenida({ nombre: user.nombre, rol: user.rol, meta, pendientes }),
      enlace: user.rol === "VENDEDOR" ? "/leads" : null,
    });
  } catch (err) {
    console.error("saludar falló para", user?.id, err);
  }
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password, cerrarOtraSesion } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña requeridos" });
    }

    const user = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
    if (!user) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const passwordOk = await bcrypt.compare(password, user.password);
    if (!passwordOk) {
      // El middleware de auditoría ignora las respuestas con error, pero un
      // intento fallido es justo lo que un admin necesita ver en el kardex.
      registrar({
        tenantId: user.tenantId,
        userId: user.id,
        userNombre: user.nombre,
        userEmail: user.email,
        userRol: user.rol,
        accion: "sesion.fallida",
        entidad: "Sesión",
        descripcion: "Intento de inicio de sesión con contraseña incorrecta",
        metodo: "POST",
        ruta: "/api/auth/login",
        statusCode: 401,
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
        userAgent: req.headers["user-agent"],
      });
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    if (!user.activo) {
      const mensaje = user.rol === "PROVEEDOR_LEADS"
        ? "Tu cuenta está pendiente de aprobación por el administrador de la empresa"
        : "Tu cuenta está inactiva";
      return res.status(403).json({ error: mensaje });
    }

    if (user.rol !== "SUPER_ADMIN") {
      const tenantStatus = user.tenant?.status;
      if (tenantStatus !== "ACTIVO") {
        const mensajes = {
          PENDIENTE: "Tu espacio aún está pendiente de aprobación",
          RECHAZADO: "Tu solicitud de espacio fue rechazada",
          SUSPENDIDO: "Tu espacio está suspendido",
        };
        return res.status(403).json({
          error: mensajes[tenantStatus] || "Tu espacio no está disponible",
          tenantStatus: tenantStatus || null,
        });
      }
    }

    // Una sola sesión por persona. Si ya hay una viva, no se entra de
    // frente: se le dice dónde está abierta y se le pregunta si la cierra.
    // La respuesta del frente es el mismo login con `cerrarOtraSesion`.
    const otraSesion = await sesionActivaDe(user.id);
    if (otraSesion && !cerrarOtraSesion) {
      return res.status(409).json({
        error: "Ya tienes una sesión activa en otro dispositivo",
        code: "SESION_ACTIVA",
        sesionActiva: {
          dispositivo: otraSesion.dispositivo,
          desde: otraSesion.createdAt,
          ultimaActividad: otraSesion.lastSeenAt,
        },
      });
    }

    if (otraSesion) {
      // Quien entra decide: la anterior se cierra en el acto y el motivo
      // queda guardado para poder explicárselo a quien la tenía abierta.
      await revocarSesiones(user.id, { motivo: "otro_inicio" });
      registrar({
        tenantId: user.tenantId,
        userId: user.id,
        userNombre: user.nombre,
        userEmail: user.email,
        userRol: user.rol,
        accion: "sesion.desplazada",
        entidad: "Sesión",
        descripcion: `${user.nombre} cerró su sesión de ${otraSesion.dispositivo || "otro dispositivo"} al entrar desde uno nuevo`,
        metodo: "POST",
        ruta: "/api/auth/login",
        statusCode: 200,
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
        userAgent: req.headers["user-agent"],
      });
    }

    const sesion = await crearSesion(user, req);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        rol: user.rol,
        nombre: user.nombre,
        tenantId: user.tenantId,
        tenantStatus: user.tenant?.status ?? null,
        // El id de la sesión: es lo que permite invalidar este token antes
        // de que expire (ver src/lib/sesiones.js).
        sid: sesion.id,
      },
      process.env.JWT_SECRET,
      { expiresIn: `${DURACION_HORAS}h` }
    );

    // Sin await: el saludo no debe retrasar el login.
    saludar(user, sesion.id);

    // Sin esto el login queda en el kardex sin usuario ni empresa (el
    // middleware corre antes de que exista req.user) y no lo ve nadie.
    detallarMovimiento(req, {
      tenantId: user.tenantId,
      userNombre: user.nombre,
      userEmail: user.email,
      descripcion: `${user.nombre} inició sesión`,
      despues: { rol: user.rol },
    });

    res.json({
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        tenantId: user.tenantId,
        tourCompletado: !!user.tourCompletadoAt,
      },
      tenant: user.tenant
        ? {
            nombre: user.tenant.nombreComercial || user.tenant.razonSocial,
            logoUrl: user.tenant.logoUrl,
            colorPrimario: user.tenant.colorPrimario,
            colorSecundario: user.tenant.colorSecundario,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/auth/logout — cierra la sesión de este token.
//
// Sin esto, "Cerrar sesión" sólo borraría el token del navegador y la fila
// seguiría viva: la persona no podría volver a entrar sin que el sistema le
// reclamara una sesión activa que ya no usa nadie.
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    if (req.user.sid) await revocarSesiones(req.user.id, { motivo: "cerrada_por_usuario" });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/auth/sesion — datos de la sesión en curso, para poder mostrar
// desde dónde se está trabajando.
router.get("/sesion", authMiddleware, async (req, res) => {
  try {
    if (!req.user.sid) return res.json({ sesion: null });
    const sesion = await prisma.sesion.findUnique({ where: { id: req.user.sid } });
    res.json({
      sesion: sesion
        ? {
            dispositivo: sesion.dispositivo,
            desde: sesion.createdAt,
            ultimaActividad: sesion.lastSeenAt,
            expira: sesion.expiresAt,
          }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/auth/tour-completado — marca el tour de bienvenida como visto
router.post("/tour-completado", authMiddleware, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tourCompletadoAt: new Date() },
    });
    res.json({ tourCompletado: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/auth/registro
router.post("/registro", async (req, res) => {
  try {
    const { tipoPersona, razonSocial, nombreComercial, nombreContacto, email, telefono, password } = req.body;

    if (!["FISICA", "MORAL"].includes(tipoPersona)) {
      return res.status(400).json({ error: "tipoPersona debe ser FISICA o MORAL" });
    }
    if (!razonSocial || !email || !password) {
      return res.status(400).json({ error: "razonSocial, email y password son requeridos" });
    }
    if (tipoPersona === "MORAL" && !nombreContacto) {
      return res.status(400).json({ error: "nombreContacto es requerido para persona moral" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    }

    const existente = await prisma.user.findUnique({ where: { email } });
    if (existente) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese email" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const resultado = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          tipoPersona,
          razonSocial,
          nombreComercial: nombreComercial || razonSocial,
          emailContacto: email,
          telefono: telefono || null,
          status: "PENDIENTE",
        },
      });

      const user = await tx.user.create({
        data: {
          nombre: nombreContacto || razonSocial,
          email,
          password: hashedPassword,
          rol: "ADMIN",
          activo: true,
          tenantId: tenant.id,
        },
      });

      return { tenant, user };
    });

    res.status(201).json({
      message: "Registro recibido, tu espacio está pendiente de aprobación",
      tenantId: resultado.tenant.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// GET /api/auth/invitacion?token=... — valida un token de invitación de proveedor y devuelve el nombre de la empresa (sin exponer el resto del catálogo de empresas)
router.get("/invitacion", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "token requerido" });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: "Invitación inválida o expirada" });
    }
    if (payload.purpose !== "proveedor_invite") {
      return res.status(400).json({ error: "Invitación inválida" });
    }

    const tenant = await prisma.tenant.findFirst({ where: { id: payload.tenantId, status: "ACTIVO" } });
    if (!tenant) return res.status(404).json({ error: "La empresa que te invitó ya no está disponible" });

    res.json({ empresa: tenant.nombreComercial || tenant.razonSocial });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/auth/registro-proveedor — alta de un proveedor externo de leads, vía token de invitación de una empresa
router.post("/registro-proveedor", async (req, res) => {
  try {
    const { nombre, email, password, token } = req.body;
    if (!nombre || !email || !password || !token) {
      return res.status(400).json({ error: "nombre, email, password y token son requeridos" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: "Invitación inválida o expirada" });
    }
    if (payload.purpose !== "proveedor_invite") {
      return res.status(400).json({ error: "Invitación inválida" });
    }

    const tenant = await prisma.tenant.findFirst({ where: { id: payload.tenantId, status: "ACTIVO" } });
    if (!tenant) return res.status(404).json({ error: "La empresa que te invitó ya no está disponible" });

    const existente = await prisma.user.findUnique({ where: { email } });
    if (existente) return res.status(409).json({ error: "Ya existe una cuenta con ese email" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        nombre,
        email,
        password: hashedPassword,
        rol: "PROVEEDOR_LEADS",
        activo: false,
        tenantId: tenant.id,
      },
    });

    res.status(201).json({
      message: "Registro recibido, tu cuenta está pendiente de aprobación por el administrador de la empresa",
      userId: user.id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
