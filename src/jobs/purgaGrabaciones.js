// Borra de Twilio el audio de las llamadas que ya pasaron su plazo de
// conservación (por defecto 15 días, configurable por empresa en
// Configuración > Operación).
//
// La fila NO se borra: queda como constancia de que esa llamada existió y
// de que su audio se eliminó. Perder el rastro de la llamada además del
// audio dejaría al kardex mintiendo sobre lo que pasó.
//
// El plazo es por empresa, así que el tick recorre los tenants que tienen
// grabaciones vivas y aplica a cada uno el suyo.
const { PrismaClient } = require("@prisma/client");
const { getParametros } = require("../lib/parametros");

const prisma = new PrismaClient();

// Una vez al día basta: el plazo se mide en días, no en minutos, y cada
// corrida habla con la API de Twilio una vez por grabación.
const INTERVAL_MS = 24 * 60 * 60 * 1000;

// Tope por corrida. La primera vez que esto se active puede haber meses de
// audio acumulado, y vaciarlo de un golpe sería cientos de llamadas
// seguidas a Twilio; lo que sobre se va en el tick siguiente.
const MAX_POR_CORRIDA = 500;

function credenciales() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return { sid, basic: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

async function borrarEnTwilio(cred, recordingSid) {
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cred.sid}/Recordings/${recordingSid}.json`,
    { method: "DELETE", headers: { Authorization: cred.basic } },
  );
  // 404 es éxito para lo que nos importa: el audio ya no está en Twilio.
  return r.ok || r.status === 404;
}

async function purgarGrabacionesVencidas() {
  const cred = credenciales();
  if (!cred) return { borradas: 0, fallidas: 0 };

  // Sólo los tenants que de verdad tienen audio guardado: preguntar los
  // parámetros de todos los demás sería trabajo para nada.
  const conAudio = await prisma.grabacionLlamada.groupBy({
    by: ["tenantId"],
    where: { estado: "COMPLETADA", recordingSid: { not: null } },
  });

  let borradas = 0;
  let fallidas = 0;

  for (const { tenantId } of conAudio) {
    const { grabacionDiasRetencion } = await getParametros(tenantId);
    const corte = new Date(Date.now() - grabacionDiasRetencion * 24 * 60 * 60 * 1000);

    const vencidas = await prisma.grabacionLlamada.findMany({
      where: {
        tenantId,
        estado: "COMPLETADA",
        recordingSid: { not: null },
        // Se mide desde que se grabó, no desde que arrancó la llamada:
        // son casi lo mismo, pero `grabadaAt` es el momento en que el audio
        // empezó a existir, que es lo que el plazo promete.
        grabadaAt: { lt: corte },
      },
      select: { id: true, recordingSid: true },
      take: MAX_POR_CORRIDA,
      orderBy: { grabadaAt: "asc" },
    });

    for (const g of vencidas) {
      try {
        if (!(await borrarEnTwilio(cred, g.recordingSid))) {
          fallidas += 1;
          continue;
        }
        // Sólo se marca BORRADA cuando Twilio confirmó: si se marcara antes
        // y el borrado fallara, el audio seguiría allá y nadie volvería a
        // intentarlo, porque la fila ya no calificaría para la purga.
        await prisma.grabacionLlamada.update({
          where: { id: g.id },
          data: { estado: "BORRADA", recordingSid: null },
        });
        borradas += 1;
      } catch (err) {
        console.error("no se pudo purgar la grabación", g.id, err);
        fallidas += 1;
      }
    }
  }

  return { borradas, fallidas };
}

// DESACTIVADO. En produccion este job tumbaba el proceso en su primer tick:
// arranque -> 5 min -> caida -> reinicio -> 5 min -> caida, en bucle. Cada
// reinicio dejaba caer las peticiones en curso, y de cara al usuario eso se
// veia como "Error del servidor" al entrar o al marcar.
//
// La causa exacta sigue sin identificarse: el tick esta envuelto en
// try/catch y cada borrado tambien, asi que no deberia poder tumbar nada.
// Hasta entender que lo mata, no vuelve a programarse: una purga que ahorra
// almacenamiento no justifica reiniciar la operacion cada cinco minutos.
//
// `purgarGrabacionesVencidas` queda exportada y probada, lista para
// reactivarse cuando se sepa que pasaba (o para correrla a mano).
const PROGRAMAR = process.env.PURGA_GRABACIONES_ACTIVA === "true";

function startPurgaGrabacionesJob() {
  if (!PROGRAMAR) {
    console.log("purga de grabaciones: desactivada (PURGA_GRABACIONES_ACTIVA != true)");
    return;
  }
  if (!credenciales()) return;

  const tick = async () => {
    try {
      const r = await purgarGrabacionesVencidas();
      if (r.borradas || r.fallidas) {
        console.log(`purga de grabaciones: ${r.borradas} borradas, ${r.fallidas} fallidas`);
      }
    } catch (err) {
      console.error("falló la purga de grabaciones", err);
    }
  };

  setInterval(tick, INTERVAL_MS);
  // Holgura al arrancar para no competir con el resto del arranque.
  setTimeout(tick, 5 * 60 * 1000);
}

module.exports = { startPurgaGrabacionesJob, purgarGrabacionesVencidas };
