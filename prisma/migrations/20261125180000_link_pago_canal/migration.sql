-- Por dónde se le mandó el link al cliente: SMS (lo de siempre) o
-- WhatsApp de la empresa por Twilio. smsSid/smsError guardan el envío en
-- cualquiera de los dos canales.
ALTER TABLE "links_pago" ADD COLUMN "canal" TEXT NOT NULL DEFAULT 'sms';
