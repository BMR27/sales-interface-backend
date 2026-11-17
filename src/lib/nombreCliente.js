// El nombre del cliente: que se acepta y como se limpia lo que llega.
//
// Los leads de CF vienen de un formulario web sin validar, asi que el
// nombre llega como lo tecleo el cliente: "Evaristo.cruz", "MARIA  LOPEZ
// 55512", "jose_antonio". La vendedora lo corrige al hablar, pero mientras
// tanto ese texto es lo que se le dice por telefono, lo que sale en el
// reporte y lo que va en la etiqueta del paquete.
//
// Dos usos, una sola regla:
//
//   validar     lo que la vendedora captura a mano. Se rechaza y se le
//               dice por que, para que lo corrija ella.
//   normalizar  lo que llega por la API. No se puede rechazar un lead por
//               un nombre mal escrito -- se cobro y el cliente existe --
//               asi que se limpia y se deja constancia del cambio, igual
//               que cuando lo corrige una persona.
//
// Que se permite: letras (con acentos y ñ), espacios, apostrofo y guion.
// Los dos ultimos porque hay apellidos que los llevan ("D'Angelo",
// "Sainz-Trapaga") y rechazarlos obligaria a escribirlos mal.
//
// Que NO: digitos y cualquier otro signo. Un numero dentro de un nombre
// siempre es basura del formulario, nunca parte del nombre.

// \p{L} cubre cualquier letra Unicode, acentos y ñ incluidos, sin tener
// que enumerarlos. \p{M} son las marcas combinantes: sin ellas, una "é"
// escrita como "e" + acento se partiria a la mitad.
const PERMITIDOS = /[\p{L}\p{M}\s'\-]/u;
const PROHIBIDOS = /[^\p{L}\p{M}\s'\-]/gu;

// ¿Tiene algo que no deberia?
function tieneCaracteresInvalidos(nombre) {
  return PROHIBIDOS.test(String(nombre || ""));
}

// Lo que sobra, para poder decirselo a quien captura: "quita los
// caracteres . y 5".
function caracteresInvalidos(nombre) {
  const malos = String(nombre || "").match(PROHIBIDOS) || [];
  return [...new Set(malos)];
}

// Limpia el nombre dejandolo utilizable.
//
// No intenta adivinar: quita lo que no es nombre, junta los espacios que
// quedan y recorta. "Evaristo.cruz" -> "Evaristo cruz". No corrige
// mayusculas ni separa palabras pegadas, porque eso ya seria inventar --
// y el nombre original queda guardado para quien quiera revisarlo.
//
// Los signos se sustituyen por un espacio y no por nada: "Evaristo.cruz"
// pegado daria "Evaristocruz", que es peor que el original.
function normalizarNombre(nombre) {
  return String(nombre || "")
    .replace(PROHIBIDOS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ¿Se puede guardar este nombre tal cual? Devuelve null si esta bien, o el
// motivo en palabras que se le puedan mostrar a la vendedora.
function validarNombre(nombre) {
  const texto = String(nombre || "").trim();
  if (!texto) return "Escribe el nombre del cliente";
  if (texto.length < 2) return "El nombre es demasiado corto";

  const malos = caracteresInvalidos(texto);
  if (malos.length > 0) {
    const lista = malos.map((c) => (c === " " ? "espacio" : `«${c}»`)).join(", ");
    return `El nombre no puede llevar números ni signos. Quita: ${lista}`;
  }
  return null;
}

module.exports = {
  PERMITIDOS,
  tieneCaracteresInvalidos,
  caracteresInvalidos,
  normalizarNombre,
  validarNombre,
};
