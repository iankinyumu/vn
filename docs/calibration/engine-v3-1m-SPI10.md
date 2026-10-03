# Engine v3 calibration report

Specification `v3.1`, commit `018b64a2c22bd3c5cca462f47b3fb99ccbaa94c9`, Node v24.20.0, generated 2026-09-28T00:53:49.233Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI10 --out docs/calibration/engine-v3-1m-SPI10
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI10 | calibration-0 | 1000000 | 10.000% | 9.997% | -0.025% | 0.615% | -0.35 | 0.27 | -0.098 | 4.29 | 9.93 | 71.4 | 7 | 9766.785–10063.157 | 0.94 | PASS |
| SPI10 | calibration-1 | 1000000 | 10.000% | 10.006% | 0.062% | 1.050% | -0.06 | 1.67 | -0.110 | 4.61 | 19.84 | 80.2 | 7 | 9900.010–10163.866 | 0.65 | PASS |
| SPI10 | calibration-2 | 1000000 | 10.000% | 9.992% | -0.084% | 1.003% | 0.86 | 0.24 | -0.098 | 4.36 | 12.01 | 99.9 | 6 | 9960.304–10363.405 | 1.42 | PASS |
| SPI10 | calibration-3 | 1000000 | 10.000% | 10.003% | 0.029% | 0.886% | 0.25 | -0.21 | -0.100 | 4.54 | 9.58 | 76.2 | 7 | 9942.973–10271.644 | 1.06 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
