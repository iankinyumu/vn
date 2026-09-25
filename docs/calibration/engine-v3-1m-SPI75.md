# Engine v3 calibration report

Specification `v3.0`, commit `7f7d5f6704e641c8e8d3ca4e0e9436b3d97ad46b`, Node v24.20.0, generated 2026-09-24T23:56:36.354Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI75 --out docs/calibration/engine-v3-1m-SPI75
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI75 | calibration-0 | 1000000 | 75.000% | 74.999% | -0.002% | 0.611% | 1.24 | -0.29 | -0.100 | 4.79 | 9.57 | 81.7 | 8 | 9334.556–13161.542 | 1.50 | PASS |
| SPI75 | calibration-1 | 1000000 | 75.000% | 74.950% | -0.066% | 0.906% | -0.03 | 0.26 | -0.095 | 4.45 | 8.31 | 70.8 | 6 | 7892.411–10562.362 | 1.30 | PASS |
| SPI75 | calibration-2 | 1000000 | 75.000% | 75.058% | 0.077% | 0.556% | 1.57 | 0.71 | -0.098 | 4.68 | 2.65 | 81.0 | 9 | 9848.048–12677.416 | 1.30 | PASS |
| SPI75 | calibration-3 | 1000000 | 75.000% | 74.918% | -0.110% | 1.028% | -0.64 | -0.28 | -0.101 | 4.58 | 11.53 | 83.9 | 7 | 7854.651–10120.130 | 1.32 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
