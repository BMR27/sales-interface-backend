// GET /api/eventos — canal de avisos en vivo (SSE).
//
// La pantalla abre esta conexion una vez y la deja escuchando. Cuando algo
// cambia en la empresa, recibe un aviso y vuelve a pedir sus datos.
//
// Autenticado con el mismo Bearer que el resto de la API: el cliente lo
// consume con fetch + ReadableStream en vez de EventSource, justamente
// para poder mandar el header. EventSource obligaria a meter el token en
// la URL, donde acabaria en los logs del servidor y del proxy.
const express = require("express");
const authMiddleware = require("../middleware/auth");
const { suscribir } = require("../lib/eventos");

const router = express.Router();

// Cada cuanto se manda una linea de vida. Sin esto, un proxy que corta
// conexiones inactivas cerraria el canal a los pocos minutos y la pantalla
// se quedaria muda sin que nadie lo note.
const LATIDO_MS = 25000;

router.get("/", authMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx y compañia bufferean respuestas por defecto, lo que retrasa
    // los eventos hasta que se llena el buffer: justo lo contrario de lo
    // que esto busca.
    "X-Accel-Buffering": "no",
  });

  res.write(`data: ${JSON.stringify({ tipo: "conectado" })}\n\n`);

  const desuscribir = suscribir(req.user.tenantId, res);

  const latido = setInterval(() => {
    try {
      // Comentario SSE: mantiene viva la conexion sin que el cliente lo
      // interprete como un cambio.
      res.write(": latido\n\n");
    } catch {
      clearInterval(latido);
    }
  }, LATIDO_MS);

  req.on("close", () => {
    clearInterval(latido);
    desuscribir();
  });
});

module.exports = router;
