// Quien puede operar un lead.
//
// Una vendedora, los suyos. La coordinadora, cualquiera de su espacio: su
// papel incluye enseñar a llamar -- se sienta con la vendedora sobre el
// lead que esa vendedora tiene enfrente -- y ademas trabaja ella misma los
// leads de la cola, que todavia no tienen dueña.
//
// Vivia suelto en src/routes/llamada.js, asi que la coordinadora podia
// abrir la llamada y marcar, pero al cerrar la venta el endpoint exigia
// que el lead fuera suyo y contestaba "Lead no encontrado". El flujo se
// rompia en el ultimo paso, despues de haber hecho la venta.
function filtroLead(user, leadId) {
  if (user.rol === "COORDINADOR") {
    return { id: leadId, tenantId: user.tenantId };
  }
  return { id: leadId, vendedorId: user.id };
}

module.exports = { filtroLead };
