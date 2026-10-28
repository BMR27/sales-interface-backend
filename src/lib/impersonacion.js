const jwt = require("jsonwebtoken");

// A donde entra una vista prestada segun el rol. Es el mismo mapa que usa
// el front en lib/guard.ts; se manda desde aqui para que quien presta la
// vista no tenga que adivinar a que pantalla ir.
const INICIO_POR_ROL = {
  ADMIN: "/admin",
  ADMIN_OPERATIVO: "/admin",
  COORDINADOR: "/coordinador",
  PROVEEDOR_LEADS: "/proveedor",
  VENDEDOR: "/leads",
};

// Roles que se pueden prestar. SUPER_ADMIN queda fuera a proposito: no hay
// nada que ver que el dueño de la plataforma no vea ya, y encadenar
// impersonaciones hace imposible auditar quien hizo que.
const ROLES_PRESTABLES = Object.keys(INICIO_POR_ROL);

// El ADMIN de un espacio puede tomar prestada la vista de su gente, pero no
// la de otro ADMIN: no ganaria ningun permiso (ya los tiene todos) y si
// perderia el rastro de quien actuo.
const ROLES_PRESTABLES_A_ADMIN = ROLES_PRESTABLES.filter((rol) => rol !== "ADMIN");

// Marca el nombre mientras dura la vista prestada. La pantalla la usa para
// mostrar de quien es la vista sin repetir el sufijo.
const SUFIJO_VISTA = " (vista prestada)";

// Arma el token de una vista prestada.
//
// `usuario` null significa "la vista generica de administrador del espacio",
// que es lo que hacia el Ver como original. Con usuario, el token lleva su
// id real: es la unica forma de que la vista exista -- la cola de una
// vendedora se arma con `vendedorId: req.user.id` -- y por eso lleva
// tambien `impersonatedBy`, que es lo que permite auditarla despues.
function construirVistaPrestada({ tenant, usuario = null, porId }) {
  const etiqueta = tenant.nombreComercial || tenant.razonSocial;
  const nombre = `${usuario ? usuario.nombre : etiqueta}${SUFIJO_VISTA}`;
  const rol = usuario ? usuario.rol : "ADMIN";
  const email = usuario ? usuario.email : tenant.emailContacto;
  const id = usuario ? usuario.id : null;

  const token = jwt.sign(
    {
      id,
      email,
      rol,
      nombre,
      tenantId: tenant.id,
      tenantStatus: tenant.status,
      impersonatedBy: porId,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  return {
    token,
    user: { id, nombre, email, rol, tenantId: tenant.id },
    destino: INICIO_POR_ROL[rol] || "/admin",
  };
}

module.exports = {
  INICIO_POR_ROL,
  ROLES_PRESTABLES,
  ROLES_PRESTABLES_A_ADMIN,
  SUFIJO_VISTA,
  construirVistaPrestada,
};
