const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña requeridos" });
    }

    const user = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
    if (!user) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const passwordOk = await bcrypt.compare(password, user.password);
    if (!passwordOk) {
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

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        rol: user.rol,
        nombre: user.nombre,
        tenantId: user.tenantId,
        tenantStatus: user.tenant?.status ?? null,
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        tenantId: user.tenantId,
      },
    });
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
