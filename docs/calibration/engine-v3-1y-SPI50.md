# Engine v3 calibration report

Specification `v3.1`, commit `1a5c11718fa15348613efbdae85b92fbf7152773`, Node v24.20.0, generated 2026-09-28T01:41:04.194Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 15768000 --seeds 1 --first-seed 0 --indices SPI50 --out docs/calibration/engine-v3-1y-SPI50
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI50 | calibration-0 | 15768000 | 50.000% | 50.009% | 0.018% | 0.935% | -0.24 | -0.06 | -0.099 | 4.72 | 1.48 | 84.4 | 8 | 7093.803–10708.724 | 0.69 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
