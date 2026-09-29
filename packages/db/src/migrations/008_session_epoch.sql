-- Session tokens are stateless HMACs; each carries the user's session_epoch at issue
-- time. Bumping the epoch (password change, logout) invalidates every earlier token.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 0;
