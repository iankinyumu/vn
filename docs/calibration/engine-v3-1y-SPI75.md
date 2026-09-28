# Engine v3 calibration report

Specification `v3.1`, commit `6b7ca3bbe23943ed84d8e0635dff1484bc8be2d0`, Node v24.20.0, generated 2026-09-28T02:01:43.126Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 15768000 --seeds 1 --first-seed 0 --indices SPI75 --out docs/calibration/engine-v3-1y-SPI75
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI75 | calibration-0 | 15768000 | 75.000% | 74.967% | -0.044% | 1.199% | 0.02 | -1.52 | -0.098 | 4.89 | 15.26 | 89.4 | 8 | 5828.846–14575.320 | 0.72 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
