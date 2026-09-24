# Engine v3 calibration report

Specification `v3.0`, commit `d9e48acf75bf2f2eae635bfb1fe7dece6c7b0429` (engine files had uncommitted changes), Node v24.20.0, generated 2026-09-24T07:11:16.652Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 15768000 --seeds 1 --first-seed 100 --indices SPI100 --out docs/calibration/engine-v3-1y-SPI100
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI100 | calibration-100 | 15768000 | 100.000% | 100.000% | -0.000% | 0.981% | 2.53 | 0.14 | -0.100 | 4.60 | 5.63 | 93.3 | 8 | 6579.177–19813.737 | 2.81 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
