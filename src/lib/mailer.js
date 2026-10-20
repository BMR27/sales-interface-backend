// Envío de correo por la API HTTP de Resend. Se usa fetch directo en vez del
// paquete `resend` para no sumar una dependencia por tres líneas -- mismo
// criterio que el resto de integraciones del proyecto.
//
// Config (Railway > Variables):
//   RESEND_API_KEY   la key de Resend (empieza con re_)
//   MAIL_FROM        remitente, p.ej. "PerfectSelft <notificaciones@perfectselft.com>"
//                    el dominio debe estar verificado en Resend
const RESEND_ENDPOINT = "https://api.resend.com/emails";

function isEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

function parseDestinatarios(valor) {
  return String(valor || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

async function sendMail({ to, subject, html, text }) {
  if (!isEnabled()) throw new Error("Correo no configurado (falta RESEND_API_KEY o MAIL_FROM)");

  const destinatarios = Array.isArray(to) ? to : parseDestinatarios(to);
  if (destinatarios.length === 0) throw new Error("Sin destinatarios válidos");

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: destinatarios,
      subject,
      html,
      text: text || undefined,
    }),
  });

  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(`Resend respondió ${res.status}: ${detalle.slice(0, 300)}`);
  }

  return res.json();
}

module.exports = { isEnabled, sendMail, parseDestinatarios };
