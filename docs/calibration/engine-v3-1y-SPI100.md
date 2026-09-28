# Engine v3 calibration report

Specification `v3.1`, commit `unknown` (engine files had uncommitted changes), Node v24.20.0, generated 2026-09-28T01:16:36.505Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 15768000 --seeds 1 --first-seed 0 --indices SPI100 --out docs/calibration/engine-v3-1y-SPI100
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI100 | calibration-0 | 15768000 | 100.000% | 100.033% | 0.033% | 0.919% | 0.93 | -0.31 | -0.101 | 4.67 | 3.86 | 87.3 | 7 | 6911.489–19358.028 | 0.66 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
