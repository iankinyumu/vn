# Engine v3 calibration report

Specification `v3.0`, commit `7f7d5f6704e641c8e8d3ca4e0e9436b3d97ad46b`, Node v24.20.0, generated 2026-09-24T23:56:36.731Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI25 --out docs/calibration/engine-v3-1m-SPI25
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI25 | calibration-0 | 1000000 | 25.000% | 25.006% | 0.025% | 0.604% | -1.09 | 0.20 | -0.103 | 4.41 | 12.68 | 65.2 | 7 | 9387.184–10242.346 | 1.04 | PASS |
| SPI25 | calibration-1 | 1000000 | 25.000% | 24.991% | -0.035% | 0.773% | -2.30 | -1.02 | -0.094 | 4.87 | 11.96 | 51.5 | 7 | 8837.214–10007.976 | 2.03 | PASS |
| SPI25 | calibration-2 | 1000000 | 25.000% | 24.995% | -0.022% | 0.834% | 0.79 | 3.02 | -0.090 | 4.70 | 7.26 | 63.6 | 7 | 9714.255–10666.663 | 1.06 | PASS |
| SPI25 | calibration-3 | 1000000 | 25.000% | 24.999% | -0.005% | 0.435% | 0.29 | 0.26 | -0.092 | 4.52 | 13.11 | 86.4 | 6 | 9755.989–10600.039 | 0.96 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
