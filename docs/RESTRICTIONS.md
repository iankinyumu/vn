# Restrictions

Restrictions have type `TRADING`, `WITHDRAWAL`, `DEPOSIT`, or `ACCESS`; scope `ALL`, `DEMO`, or `REAL`; and severity `NOTICE`, `LIMITED`, or `BLOCKED`. Expired rows are ignored. ACCESS bans must additionally be enforced through Supabase Auth ban/session revocation; that is a follow-up, not simulated by the engine.
