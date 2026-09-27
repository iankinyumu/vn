-- Owner request (2026-09-27): index names read "SP Index 10", "SP Index 25" and so on,
-- instead of "SmartProfit Index 10". Display names only: codes, prices, seeds,
-- proofs and every contract are unchanged.
update public.engine_indices
   set display_name = 'SP Index ' || substring(code from 4)
 where code ~ '^SPI(10|25|50|75|100)$'
   and display_name is distinct from 'SP Index ' || substring(code from 4);
