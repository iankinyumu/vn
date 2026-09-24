# Engine v3 calibration report

Specification `v3.0`, commit `d9e48acf75bf2f2eae635bfb1fe7dece6c7b0429` (engine files had uncommitted changes), Node v24.20.0, generated 2026-09-24T06:30:49.347Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI100 --out docs/calibration/engine-v3-1m-SPI100
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI100 | calibration-0 | 1000000 | 100.000% | 100.002% | 0.002% | 0.581% | -0.11 | 0.73 | -0.104 | 4.44 | 11.80 | 83.1 | 6 | 7540.806–11236.838 | 1.16 | PASS |
| SPI100 | calibration-1 | 1000000 | 100.000% | 99.914% | -0.086% | 0.861% | -0.09 | 0.47 | -0.099 | 4.43 | 7.58 | 73.7 | 7 | 7857.647–10638.702 | 0.99 | PASS |
| SPI100 | calibration-2 | 1000000 | 100.000% | 100.120% | 0.120% | 1.025% | 1.21 | -1.22 | -0.103 | 4.44 | 9.71 | 86.9 | 6 | 8195.415–14039.557 | 1.39 | PASS |
| SPI100 | calibration-3 | 1000000 | 100.000% | 100.002% | 0.002% | 0.624% | -0.07 | 0.97 | -0.101 | 4.79 | 5.79 | 83.6 | 6 | 8738.315–11586.238 | 0.60 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
