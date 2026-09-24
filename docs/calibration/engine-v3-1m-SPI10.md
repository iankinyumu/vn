# Engine v3 calibration report

Specification `v3.0`, commit `d9e48acf75bf2f2eae635bfb1fe7dece6c7b0429` (engine files had uncommitted changes), Node v24.20.0, generated 2026-09-24T06:30:50.418Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI10 --out docs/calibration/engine-v3-1m-SPI10
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI10 | calibration-0 | 1000000 | 10.000% | 9.997% | -0.025% | 0.617% | -0.34 | 0.27 | -0.098 | 4.29 | 9.93 | 71.4 | 7 | 9788.595–10063.337 | 0.88 | PASS |
| SPI10 | calibration-1 | 1000000 | 10.000% | 10.006% | 0.061% | 1.048% | -0.07 | 1.67 | -0.110 | 4.61 | 19.84 | 80.2 | 7 | 9897.170–10165.636 | 0.67 | PASS |
| SPI10 | calibration-2 | 1000000 | 10.000% | 9.992% | -0.085% | 1.006% | 0.85 | 0.23 | -0.098 | 4.39 | 12.01 | 99.9 | 6 | 9960.354–10305.985 | 1.24 | PASS |
| SPI10 | calibration-3 | 1000000 | 10.000% | 10.003% | 0.028% | 0.885% | 0.26 | -0.21 | -0.100 | 4.54 | 9.58 | 76.2 | 7 | 9943.213–10253.694 | 1.03 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
