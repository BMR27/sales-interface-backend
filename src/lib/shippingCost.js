// Reglas de costo de envío (Juan Carlos, observación de negocio):
// - Fuera de cobertura FullVector: $190 fijo (la paquetería alterna
//   -Estafeta/DHL- la resuelve Juan Carlos por separado, esto solo calcula
//   el costo a cobrar).
// - Dentro de cobertura (o cobertura desconocida -- no se castiga al
//   cliente por una falla técnica de verificación): menos de 3 piezas
//   compradas, $250; 3 piezas o más, $0.
function calcularCostoEnvio({ cantidadTotal, cobertura }) {
  if (cobertura === false) return 190;
  return cantidadTotal >= 3 ? 0 : 250;
}

module.exports = { calcularCostoEnvio };
