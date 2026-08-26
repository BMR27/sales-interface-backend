const POINTER_KEY = "lastAssignedVendedorId";

async function getNextVendedor(prisma, tenantId) {
  const vendedores = await prisma.user.findMany({
    where: { rol: "VENDEDOR", activo: true, tenantId },
    orderBy: { id: "asc" },
  });
  if (vendedores.length === 0) return null;

  const setting = await prisma.appSetting.findFirst({ where: { tenantId, key: POINTER_KEY } });
  const lastId = setting ? parseInt(setting.value, 10) : null;

  let next = vendedores.find((v) => v.id > lastId);
  if (!next) next = vendedores[0];

  if (setting) {
    await prisma.appSetting.update({ where: { id: setting.id }, data: { value: String(next.id) } });
  } else {
    await prisma.appSetting.create({ data: { tenantId, key: POINTER_KEY, value: String(next.id) } });
  }

  return next;
}

module.exports = { getNextVendedor };
