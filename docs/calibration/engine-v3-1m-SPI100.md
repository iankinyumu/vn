# Engine v3 calibration report

Specification `v3.1`, commit `1a5c11718fa15348613efbdae85b92fbf7152773`, Node v24.20.0, generated 2026-09-28T01:30:26.143Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI100 --out docs/calibration/engine-v3-1m-SPI100
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI100 | calibration-0 | 1000000 | 100.000% | 100.002% | 0.002% | 0.579% | -0.11 | 0.73 | -0.104 | 4.44 | 11.80 | 83.1 | 6 | 7502.446–11302.498 | 1.14 | PASS |
| SPI100 | calibration-1 | 1000000 | 100.000% | 99.914% | -0.086% | 0.861% | -0.09 | 0.47 | -0.099 | 4.43 | 7.58 | 73.7 | 7 | 7602.327–10641.772 | 1.09 | PASS |
| SPI100 | calibration-2 | 1000000 | 100.000% | 100.120% | 0.120% | 1.025% | 1.21 | -1.22 | -0.103 | 4.44 | 9.71 | 86.9 | 6 | 8041.635–13904.297 | 1.31 | PASS |
| SPI100 | calibration-3 | 1000000 | 100.000% | 100.002% | 0.002% | 0.624% | -0.07 | 0.96 | -0.101 | 4.79 | 5.79 | 83.6 | 6 | 8783.745–11609.578 | 0.59 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
