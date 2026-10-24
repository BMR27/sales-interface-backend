// Frases de aliento para la vendedora.
//
// No son decorativas: cada grupo corresponde a un momento distinto de la
// jornada (acaba de empezar, va a medias, está a una venta de la meta, ya la
// pasó) y se elige una al azar dentro del grupo que le toca según sus
// números. Así el aviso dice algo que de verdad corresponde a su avance, y
// no repite la misma frase todos los días.
//
// Los huecos disponibles son {nombre}, {faltan}, {ventas}, {meta},
// {piezas}, {piezasParaBloque} y {comision}. Una frase sólo puede usar los
// que su grupo garantiza.

const ARRANQUE = [
  "Hoy empieza en ceros, {nombre}, y eso es bueno: la primera llamada decide el día.",
  "Buen momento para arrancar. La meta de hoy son {meta} ventas y todas empiezan igual: marcando.",
  "{nombre}, nadie cierra la venta que no se intenta. Toma el primer lead de la cola.",
  "El día está limpio. Tres llamadas seguidas y ya vas a traer ritmo.",
  "Arranca sin pensarlo mucho: la primera llamada es siempre la más cara.",
];

const VA_CAMINANDO = [
  "Llevas {ventas} de {meta}, {nombre}. Vas armando el día.",
  "{ventas} ventas y la mañana no se acaba. Mantén el ritmo.",
  "Vas bien: {ventas} de {meta}. Te faltan {faltan} para cerrar la meta.",
  "Cada lead que contestas te acerca. Llevas {ventas}, van {faltan} para la meta.",
  "{nombre}, {ventas} ventas ya son terreno ganado. Sigue.",
];

const MITAD = [
  "Mitad de camino: {ventas} de {meta}. Lo que falta pesa menos que lo que ya hiciste.",
  "Ya pasaste la mitad, {nombre}. Te faltan {faltan} ventas.",
  "{ventas} de {meta} y contando. Desde aquí la meta ya se ve.",
  "Vas a la mitad y con tiempo. {faltan} más y cerraste.",
];

const CERCA = [
  "¡{faltan} para la meta, {nombre}! No la sueltes ahora.",
  "Estás a {faltan} de cerrar el día en meta. Esa llamada que sigue puede ser.",
  "{ventas} de {meta}. Lo difícil ya lo hiciste.",
  "Falta muy poco: {faltan}. Termina lo que empezaste.",
];

const META_CUMPLIDA = [
  "¡Meta del día cumplida, {nombre}! {ventas} ventas. Lo que siga es ganancia.",
  "Cerraste la meta: {ventas} de {meta}. Excelente día.",
  "Meta lograda, {nombre}. Cada venta de aquí en adelante suma extra a tu quincena.",
  "{ventas} ventas hoy. Así se ve un buen día.",
];

const CERCA_DE_BLOQUE = [
  "Te falta {piezasParaBloque} pieza para cerrar otro bloque de comisión, {nombre}.",
  "{piezasParaBloque} pieza más y se te abona otro bloque. Está ahí.",
  "Llevas {piezas} piezas en la quincena. Con {piezasParaBloque} más cierras bloque.",
];

const GRUPOS = {
  arranque: ARRANQUE,
  caminando: VA_CAMINANDO,
  mitad: MITAD,
  cerca: CERCA,
  meta: META_CUMPLIDA,
  bloque: CERCA_DE_BLOQUE,
};

// El grupo que le toca según sus números. `cercaDeBloque` gana sobre el
// avance de la meta porque es lo más accionable: una pieza para cobrar más.
function grupoPara({ ventas, meta, piezasParaBloque }) {
  if (piezasParaBloque === 1) return "bloque";
  if (ventas === 0) return "arranque";
  const avance = meta > 0 ? ventas / meta : 0;
  if (avance >= 1) return "meta";
  if (avance >= 0.8) return "cerca";
  if (avance >= 0.5) return "mitad";
  return "caminando";
}

function rellenar(plantilla, datos) {
  return plantilla.replace(/\{(\w+)\}/g, (_, clave) =>
    datos[clave] === undefined || datos[clave] === null ? "" : String(datos[clave])
  );
}

// `semilla` existe para que la frase del día sea estable: la misma vendedora
// el mismo día ve siempre la misma frase, aunque recargue. Sin esto el
// mensaje cambiaría en cada consulta y se sentiría nervioso.
function elegir(lista, semilla) {
  if (semilla == null) return lista[Math.floor(Math.random() * lista.length)];
  let h = 0;
  const s = String(semilla);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return lista[h % lista.length];
}

// Devuelve { grupo, mensaje }. `datos` necesita al menos nombre, ventas,
// meta y, si se quiere el grupo de bloque, piezas y piezasParaBloque.
function frasePara(datos, semilla = null) {
  const grupo = grupoPara({
    ventas: datos.ventas || 0,
    meta: datos.meta || 0,
    piezasParaBloque: datos.piezasParaBloque,
  });
  const faltan = Math.max((datos.meta || 0) - (datos.ventas || 0), 0);
  const plantilla = elegir(GRUPOS[grupo], semilla);
  return {
    grupo,
    mensaje: rellenar(plantilla, {
      ...datos,
      faltan,
      // Sólo el nombre de pila: "Citlali, vas a la mitad" se lee como algo
      // dicho a una persona, no como un reporte.
      nombre: (datos.nombre || "").split(" ")[0] || "¡hey!",
    }),
  };
}

// --- Bienvenida al iniciar sesión ---

const BIENVENIDAS = [
  "Qué bueno verte, {nombre}. Tu cola y tus números están listos.",
  "Te damos la bienvenida, {nombre}. Hoy la meta son {meta} ventas.",
  "Hola, {nombre}. Tienes {pendientes} leads esperando.",
  "A darle, {nombre}. Un buen día se construye con la primera llamada.",
  "Hola de nuevo, {nombre}. Lo de ayer ya pasó; hoy cuenta desde cero.",
];

const BIENVENIDAS_GENERICAS = [
  "Te damos la bienvenida de nuevo, {nombre}.",
  "Hola, {nombre}. Tu panel está al día.",
  "Qué gusto verte, {nombre}.",
];

function bienvenida({ nombre, rol, meta = 0, pendientes = 0 }, semilla = null) {
  const lista = rol === "VENDEDOR" ? BIENVENIDAS : BIENVENIDAS_GENERICAS;
  // Una vendedora sin leads en la cola no debe leer "tienes 0 leads
  // esperando": se descarta esa frase cuando no aplica.
  const candidatas = pendientes > 0 ? lista : lista.filter((f) => !f.includes("{pendientes}"));
  return rellenar(elegir(candidatas, semilla), {
    nombre: (nombre || "").split(" ")[0] || "",
    meta,
    pendientes,
  });
}

module.exports = { frasePara, bienvenida, grupoPara };
