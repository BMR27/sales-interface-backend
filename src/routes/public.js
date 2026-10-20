const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { direccionDesdeCoordenadas } = require("../lib/reverseGeocode");

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/public/branding?host=empresaA.midominio.com
// Sin autenticacion: la pantalla de login necesita saber de que empresa es
// antes de que exista cualquier sesion. Si el host no coincide con ningun
// dominio/subdominio configurado, responde { tenant: null } y el frontend
// usa el branding por defecto de la plataforma (comportamiento actual).
router.get("/branding", async (req, res) => {
  try {
    const host = String(req.query.host || "").toLowerCase().trim();
    if (!host) return res.json({ tenant: null });

    let tenant = await prisma.tenant.findFirst({
      where: { dominioPersonalizado: host, status: "ACTIVO" },
    });

    if (!tenant) {
      const rootDomain = String(process.env.ROOT_DOMAIN || "").toLowerCase().trim();
      if (rootDomain && host.endsWith(`.${rootDomain}`)) {
        const sub = host.slice(0, -(rootDomain.length + 1));
        if (sub && !sub.includes(".")) {
          tenant = await prisma.tenant.findFirst({
            where: { subdominio: sub, status: "ACTIVO" },
          });
        }
      }
    }

    if (!tenant) return res.json({ tenant: null });

    res.json({
      tenant: {
        nombre: tenant.nombreComercial || tenant.razonSocial,
        logoUrl: tenant.logoUrl,
        colorPrimario: tenant.colorPrimario,
        colorSecundario: tenant.colorSecundario,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

const UBICACION_TOKEN_VALIDEZ_MS = 24 * 60 * 60 * 1000;

function leadPorToken(token) {
  return prisma.lead.findUnique({ where: { ubicacionToken: token } });
}

function tokenVigente(lead) {
  if (!lead || !lead.ubicacionSolicitadaAt) return false;
  return Date.now() - new Date(lead.ubicacionSolicitadaAt).getTime() < UBICACION_TOKEN_VALIDEZ_MS;
}

// GET /api/public/ubicacion/:token — valida el link que se manda por SMS
// (ver POST /api/leads/:id/solicitar-ubicacion) antes de mostrar el botón
// de compartir ubicación. Nunca expone teléfono, dirección ni ningún otro
// dato del lead -- solo el nombre, para personalizar el saludo.
router.get("/ubicacion/:token", async (req, res) => {
  try {
    const lead = await leadPorToken(req.params.token);
    if (!lead) return res.json({ valid: false, motivo: "no_encontrado" });
    if (!tokenVigente(lead)) return res.json({ valid: false, motivo: "expirado" });
    res.json({ valid: true, nombre: lead.nombre });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// POST /api/public/ubicacion/:token — guarda la ubicación compartida por
// el cliente. Sin autenticación: el token es la autorización.
router.post("/ubicacion/:token", async (req, res) => {
  try {
    const lead = await leadPorToken(req.params.token);
    if (!lead) return res.status(404).json({ error: "Enlace no válido" });
    if (!tokenVigente(lead)) return res.status(410).json({ error: "Enlace expirado" });

    const { lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat y lng requeridos" });
    }

    const datos = { lat, lng, ubicacionCompartidaAt: new Date() };

    // Rellena la dirección desde las coordenadas para que la orden llegue
    // completa a FullVector, que rechaza de forma permanente cualquier
    // dirección incompleta (ver buildOrderPayload en src/lib/fullvector.js).
    // Solo toca campos vacíos: lo que ya capturó la vendedora manda, porque
    // se lo preguntó al cliente directamente.
    try {
      const dir = await direccionDesdeCoordenadas(lat, lng);
      if (dir) {
        if (!lead.shippingStreet && dir.calle) datos.shippingStreet = dir.calle;
        if (!lead.shippingNumber && dir.numero) datos.shippingNumber = dir.numero;
        if (!lead.zipCode && dir.cp) datos.zipCode = dir.cp;
        if (!lead.colonia && dir.colonia) datos.colonia = dir.colonia;
        if (!lead.municipio && dir.municipio) datos.municipio = dir.municipio;
        if (!lead.state && dir.estado) datos.state = dir.estado;
      }
    } catch (err) {
      // Nunca se pierde la ubicación por culpa del geocodificador: es el
      // dato que el cliente ya entregó y lo caro de recuperar.
      console.error("No se pudo resolver la dirección del lead", lead.id, err.message);
    }

    await prisma.lead.update({ where: { id: lead.id }, data: datos });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

module.exports = router;
