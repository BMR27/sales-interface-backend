// La regla vive en src/lib/parametros.js, que la calcula con los valores
// configurados por la empresa en vez de constantes. Este módulo se mantiene
// como punto de entrada para quien ya lo importaba.
const { calcularCostoEnvio, valoresPorDefecto } = require("./parametros");

module.exports = { calcularCostoEnvio, valoresPorDefecto };
