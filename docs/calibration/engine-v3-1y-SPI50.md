# Engine v3 calibration report

Specification `v3.0`, commit `d9e48acf75bf2f2eae635bfb1fe7dece6c7b0429` (engine files had uncommitted changes), Node v24.20.0, generated 2026-09-24T07:11:14.723Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 15768000 --seeds 1 --first-seed 100 --indices SPI50 --out docs/calibration/engine-v3-1y-SPI50
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI50 | calibration-100 | 15768000 | 50.000% | 49.999% | -0.002% | 0.989% | 0.49 | -0.07 | -0.102 | 4.70 | 4.35 | 81.1 | 7 | 7907.646–13015.406 | 2.16 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
