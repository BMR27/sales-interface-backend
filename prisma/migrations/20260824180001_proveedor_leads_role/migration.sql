-- AlterEnum
ALTER TYPE "Rol" ADD VALUE 'PROVEEDOR_LEADS';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "createdByUserId" INTEGER;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

