-- Marca FC FV (Fuera de Cobertura Full Vector) del lead: refleja lo que
-- FullVector responde para su código postal, para que la vendedora lo sepa
-- desde la llamada inicial y cierre como prepago cuando aplica.
ALTER TABLE "leads" ADD COLUMN "coberturaFv" BOOLEAN;
ALTER TABLE "leads" ADD COLUMN "coberturaFvAt" TIMESTAMP(3);
