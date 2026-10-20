-- CreateTable
CREATE TABLE "role_permisos" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "rol" "Rol" NOT NULL,
    "clave" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "role_permisos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "role_permisos_tenantId_rol_clave_key" ON "role_permisos"("tenantId", "rol", "clave");

-- AddForeignKey
ALTER TABLE "role_permisos" ADD CONSTRAINT "role_permisos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

