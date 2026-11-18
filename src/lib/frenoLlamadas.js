// Quién puede parar la salida de llamadas.
//
// El freno no se gobierna por rol sino por PERSONA, y es deliberado: es
// la única palanca del sistema que detiene a toda la operación de golpe,
// y la dirección pidió que no bastara con ser administrador. Hay dos
// cuentas ADMIN en el espacio y solo una debe poder usarlo.
//
// Se identifica por correo y no por id: el id cambia entre entornos --
// el Bryan de producción no es el id 1 en una base nueva -- y un número
// suelto en el código no dice a quién autoriza. El correo se lee y se
// audita.
//
// Configurable por entorno para no tener que desplegar cuando cambie la
// persona autorizada. El valor por omisión es el de producción: dejarlo
// vacío apagaría el freno para todos y lo volvería inservible justo el
// día que haga falta.
const AUTORIZADOS = (process.env.EMAILS_FRENO_LLAMADAS || "bryan.mejia@perfectself.com.mx")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// El parámetro que gobierna. Se nombra aquí para que la ruta no tenga que
// repetir la cadena y para que buscarla lleve a este archivo.
const CLAVE = "llamadasBloqueadas";

function puedeFrenarLlamadas(user) {
  const correo = String(user?.email || "").trim().toLowerCase();
  if (!correo) return false;
  return AUTORIZADOS.includes(correo);
}

module.exports = { AUTORIZADOS, CLAVE, puedeFrenarLlamadas };
