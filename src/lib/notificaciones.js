const { isEnabled, sendMail, parseDestinatarios } = require("./mailer");

const prisma = require("./prisma");

// Las notificaciones se configuran por empresa desde Configuración (solo
// ADMIN), no por variable de entorno: quién recibe los avisos es una
// decisión del negocio, no del despliegue.
const KEY_ACTIVO = "notificaciones.lead_nuevo.activo";
const KEY_DESTINATARIOS = "notificaciones.lead_nuevo.destinatarios";

// Destinatario inicial mientras nadie haya configurado nada todavía.
const DESTINATARIO_POR_DEFECTO = "bryan@fullvector.com.mx";

async function getConfig(tenantId) {
  const filas = await prisma.appSetting.findMany({
    where: { tenantId, key: { in: [KEY_ACTIVO, KEY_DESTINATARIOS] } },
  });
  const mapa = Object.fromEntries(filas.map((f) => [f.key, f.value]));
  const destinatariosGuardados = mapa[KEY_DESTINATARIOS];

  return {
    // Default-on: si nadie ha tocado la configuración, el aviso llega.
    activo: mapa[KEY_ACTIVO] == null ? true : mapa[KEY_ACTIVO] === "true",
    destinatarios: destinatariosGuardados != null
      ? parseDestinatarios(destinatariosGuardados)
      : [DESTINATARIO_POR_DEFECTO],
    configurado: destinatariosGuardados != null,
  };
}

async function setConfig(tenantId, { activo, destinatarios }) {
  const guardar = async (key, value) => {
    const existente = await prisma.appSetting.findFirst({ where: { tenantId, key } });
    if (existente) {
      await prisma.appSetting.update({ where: { id: existente.id }, data: { value } });
    } else {
      await prisma.appSetting.create({ data: { tenantId, key, value } });
    }
  };

  if (activo !== undefined) await guardar(KEY_ACTIVO, activo ? "true" : "false");
  if (destinatarios !== undefined) await guardar(KEY_DESTINATARIOS, destinatarios.join(", "));

  return getConfig(tenantId);
}

const ESTILO_BASE = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2430;line-height:1.5`;

function fila(etiqueta, valor) {
  if (valor == null || valor === "") return "";
  return `<tr>
    <td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap">${etiqueta}</td>
    <td style="padding:6px 0;font-size:14px;font-weight:600">${String(valor)}</td>
  </tr>`;
}

function plantillaLead(lead, { vendedor, origen }) {
  const ubicacion = [lead.city, lead.state, lead.country].filter(Boolean).join(", ");
  const origenTexto = origen === "api_externa" ? "API del proveedor" : "Alta manual";

  return `<div style="${ESTILO_BASE};max-width:560px">
    <h2 style="margin:0 0 4px;font-size:18px">Nuevo lead: ${lead.nombre}</h2>
    <p style="margin:0 0 20px;color:#6b7280;font-size:13px">${origenTexto} · ${new Date(lead.createdAt).toLocaleString("es-MX")}</p>
    <table style="border-collapse:collapse;width:100%">
      ${fila("Cliente", [lead.nombre, lead.apellido].filter(Boolean).join(" "))}
      ${fila("Teléfono", lead.telefono)}
      ${fila("Producto", lead.producto)}
      ${fila("Cantidad", lead.cantidad)}
      ${fila("Categoría", lead.categoria)}
      ${fila("Folio", lead.folio)}
      ${fila("SKU", lead.internalSku || lead.externalSku)}
      ${fila("Ubicación", ubicacion)}
      ${fila("Código postal", lead.zipCode)}
      ${fila("Asignado a", vendedor ? `${vendedor.nombre} (${vendedor.email})` : null)}
      ${fila("ID del lead", lead.id)}
    </table>
  </div>`;
}

function textoLead(lead, { vendedor, origen }) {
  return [
    `Nuevo lead: ${lead.nombre}`,
    `Origen: ${origen === "api_externa" ? "API del proveedor" : "Alta manual"}`,
    `Teléfono: ${lead.telefono}`,
    `Producto: ${lead.producto} (x${lead.cantidad})`,
    lead.folio ? `Folio: ${lead.folio}` : null,
    vendedor ? `Asignado a: ${vendedor.nombre} (${vendedor.email})` : null,
    `ID: ${lead.id}`,
  ].filter(Boolean).join("\n");
}

// Aviso de un lead recién creado. Se llama sin await a propósito: el correo
// no debe retrasar (ni tumbar) la respuesta de la creación del lead.
async function notificarLeadNuevo(lead, { vendedor = null, origen = "web" } = {}) {
  try {
    if (!isEnabled()) return;
    const config = await getConfig(lead.tenantId);
    if (!config.activo || config.destinatarios.length === 0) return;

    await sendMail({
      to: config.destinatarios,
      subject: `Nuevo lead: ${lead.nombre} — ${lead.producto}`,
      html: plantillaLead(lead, { vendedor, origen }),
      text: textoLead(lead, { vendedor, origen }),
    });
  } catch (err) {
    console.error("notificarLeadNuevo falló para el lead", lead?.id, err);
  }
}

// Las cargas masivas van en un solo correo: un Excel de 500 leads no puede
// convertirse en 500 avisos.
async function notificarLeadsImportados(tenantId, leads, { importadoPor = null } = {}) {
  try {
    if (!isEnabled() || leads.length === 0) return;
    const config = await getConfig(tenantId);
    if (!config.activo || config.destinatarios.length === 0) return;

    const filas = leads.slice(0, 100).map((l) => `<tr>
      <td style="padding:4px 12px 4px 0;font-size:13px">${l.nombre}</td>
      <td style="padding:4px 12px 4px 0;font-size:13px">${l.telefono}</td>
      <td style="padding:4px 0;font-size:13px">${l.producto}</td>
    </tr>`).join("");

    const restantes = leads.length > 100 ? `<p style="color:#6b7280;font-size:13px">…y ${leads.length - 100} más.</p>` : "";

    await sendMail({
      to: config.destinatarios,
      subject: `${leads.length} leads nuevos cargados`,
      html: `<div style="${ESTILO_BASE};max-width:560px">
        <h2 style="margin:0 0 4px;font-size:18px">${leads.length} leads nuevos</h2>
        <p style="margin:0 0 20px;color:#6b7280;font-size:13px">Carga en lote${importadoPor ? ` por ${importadoPor}` : ""} · ${new Date().toLocaleString("es-MX")}</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><th align="left" style="font-size:12px;color:#6b7280;padding-bottom:6px">Cliente</th><th align="left" style="font-size:12px;color:#6b7280">Teléfono</th><th align="left" style="font-size:12px;color:#6b7280">Producto</th></tr>
          ${filas}
        </table>
        ${restantes}
      </div>`,
      text: `${leads.length} leads nuevos cargados en lote.`,
    });
  } catch (err) {
    console.error("notificarLeadsImportados falló", err);
  }
}

// Aviso de una venta que cayó fuera de la cobertura de la mensajería. No
// comparte el interruptor de `lead_nuevo`: quien atiende los leads nuevos no
// es necesariamente quien cobra las transferencias, así que tiene su propia
// configuración y, mientras nadie la toque, hereda los destinatarios de
// aquélla para que el aviso no se pierda.
const KEY_COBERTURA_ACTIVO = "notificaciones.venta_sin_cobertura.activo";
const KEY_COBERTURA_DESTINATARIOS = "notificaciones.venta_sin_cobertura.destinatarios";

async function getConfigSinCobertura(tenantId) {
  const filas = await prisma.appSetting.findMany({
    where: { tenantId, key: { in: [KEY_COBERTURA_ACTIVO, KEY_COBERTURA_DESTINATARIOS] } },
  });
  const mapa = Object.fromEntries(filas.map((f) => [f.key, f.value]));
  const guardados = mapa[KEY_COBERTURA_DESTINATARIOS];
  const heredados = guardados == null ? (await getConfig(tenantId)).destinatarios : null;

  return {
    activo: mapa[KEY_COBERTURA_ACTIVO] == null ? true : mapa[KEY_COBERTURA_ACTIVO] === "true",
    destinatarios: guardados != null ? parseDestinatarios(guardados) : heredados,
    configurado: guardados != null,
  };
}

async function setConfigSinCobertura(tenantId, { activo, destinatarios }) {
  const guardar = async (key, value) => {
    const existente = await prisma.appSetting.findFirst({ where: { tenantId, key } });
    if (existente) await prisma.appSetting.update({ where: { id: existente.id }, data: { value } });
    else await prisma.appSetting.create({ data: { tenantId, key, value } });
  };

  if (activo !== undefined) await guardar(KEY_COBERTURA_ACTIVO, activo ? "true" : "false");
  if (destinatarios !== undefined) await guardar(KEY_COBERTURA_DESTINATARIOS, destinatarios.join(", "));

  return getConfigSinCobertura(tenantId);
}

async function notificarVentaSinCobertura(venta, lead, { vendedor = null } = {}) {
  try {
    if (!isEnabled()) return;
    const config = await getConfigSinCobertura(venta.tenantId);
    if (!config.activo || config.destinatarios.length === 0) return;

    const direccion = [lead?.shippingStreet, lead?.shippingNumber, lead?.colonia, lead?.municipio, lead?.state, lead?.zipCode]
      .filter(Boolean)
      .join(", ");
    const total = venta.monto + (venta.costoEnvio || 0);
    const enlace = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/prepago` : null;

    await sendMail({
      to: config.destinatarios,
      subject: `Venta sin cobertura (prepago): ${venta.folio || `#${venta.id}`} — ${lead?.nombre || "cliente"}`,
      html: `<div style="${ESTILO_BASE};max-width:560px">
        <h2 style="margin:0 0 4px;font-size:18px">Venta fuera de cobertura: hay que cobrarla por transferencia</h2>
        <p style="margin:0 0 20px;color:#6b7280;font-size:13px">
          En el CP ${lead?.zipCode || "(sin CP)"} la mensajería no ofrece pago en efectivo contra entrega.
          Hay que llamar al cliente, ofrecerle transferencia y, una vez confirmada, enviar por mensajería tradicional.
        </p>
        <table style="border-collapse:collapse;width:100%">
          ${fila("Folio", venta.folio)}
          ${fila("Cliente", [lead?.nombre, lead?.apellido].filter(Boolean).join(" "))}
          ${fila("Teléfono", lead?.telefono)}
          ${fila("Producto", lead?.producto)}
          ${fila("Dirección", direccion)}
          ${fila("Total a cobrar", `$${Math.round(total).toLocaleString("es-MX")}`)}
          ${fila("Vendedora", vendedor ? vendedor.nombre : null)}
          ${fila("ID en FullVector", venta.fullvectorOrderId)}
        </table>
        ${enlace ? `<p style="margin:20px 0 0"><a href="${enlace}" style="font-size:14px">Gestionar en PerfectSelft</a></p>` : ""}
      </div>`,
      text: [
        `Venta fuera de cobertura: ${venta.folio || `#${venta.id}`}`,
        `Cliente: ${lead?.nombre || ""} (${lead?.telefono || "sin teléfono"})`,
        `CP ${lead?.zipCode || "?"} sin pago contra entrega: cobrar por transferencia.`,
        `Total: $${Math.round(total).toLocaleString("es-MX")}`,
        enlace,
      ].filter(Boolean).join("\n"),
    });
  } catch (err) {
    console.error("notificarVentaSinCobertura falló para la venta", venta?.id, err);
  }
}

module.exports = {
  getConfig,
  setConfig,
  getConfigSinCobertura,
  setConfigSinCobertura,
  notificarLeadNuevo,
  notificarLeadsImportados,
  notificarVentaSinCobertura,
  DESTINATARIO_POR_DEFECTO,
};
