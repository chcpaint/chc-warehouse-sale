-- 009_order_closure_fields.sql
-- Records step-3 (payment received / order closed) of the branch workflow.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_at   timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS closed_by uuid;
CREATE INDEX IF NOT EXISTS idx_orders_closed_at ON public.orders(closed_at);
