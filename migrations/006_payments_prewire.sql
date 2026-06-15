-- 006_payments_prewire.sql
-- Pre-wire online payments (Stripe). Additive + inert: existing PO orders stay 'unpaid'.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_status   varchar(20) NOT NULL DEFAULT 'unpaid';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_provider varchar(20);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_intent_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS amount_paid      numeric NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_at          timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE constraint_name = 'orders_payment_status_check' AND table_name = 'orders'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_payment_status_check
      CHECK (payment_status IN ('unpaid','pending','paid','refunded','failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON public.orders(payment_status);
