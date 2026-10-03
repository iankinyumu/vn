# Engine v3 calibration report

Specification `v3.1`, commit `1a5c11718fa15348613efbdae85b92fbf7152773`, Node v24.20.0, generated 2026-09-28T01:09:28.667Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI50 --out docs/calibration/engine-v3-1m-SPI50
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI50 | calibration-0 | 1000000 | 50.000% | 50.019% | 0.038% | 0.666% | -1.01 | -1.81 | -0.097 | 4.57 | 5.02 | 102.1 | 7 | 8647.872–10437.785 | 1.15 | PASS |
| SPI50 | calibration-1 | 1000000 | 50.000% | 49.951% | -0.099% | 0.823% | 2.00 | 0.06 | -0.099 | 4.38 | 2.41 | 85.7 | 6 | 9941.013–12838.613 | 1.98 | PASS |
| SPI50 | calibration-2 | 1000000 | 50.000% | 50.002% | 0.004% | 0.807% | 0.72 | 1.65 | -0.097 | 4.18 | 7.60 | 93.8 | 6 | 9634.451–11175.127 | 0.88 | PASS |
| SPI50 | calibration-3 | 1000000 | 50.000% | 49.958% | -0.083% | 1.089% | -1.01 | 0.18 | -0.104 | 4.62 | 7.54 | 66.4 | 6 | 7782.497–10202.467 | 1.99 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
