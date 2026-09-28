# Engine v3 calibration report

Specification `v3.1`, commit `1a5c11718fa15348613efbdae85b92fbf7152773`, Node v24.20.0, generated 2026-09-28T01:01:17.326Z.

Reproduce with:

```
node scripts/engine-v3-calibrate.mjs --ticks 1000000 --seeds 4 --first-seed 0 --indices SPI25 --out docs/calibration/engine-v3-1m-SPI25
```

Seeds are `SHA-256("calibration-<n>")`; each UTC-day epoch seed is `SHA-256(root ‖ u64(epoch_start_ms))`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is 137.2. A `—` check was not applicable at this sample size.

| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\|e\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SPI25 | calibration-0 | 1000000 | 25.000% | 25.006% | 0.025% | 0.604% | -1.09 | 0.19 | -0.103 | 4.41 | 12.68 | 65.2 | 7 | 9279.624–10244.906 | 1.19 | PASS |
| SPI25 | calibration-1 | 1000000 | 25.000% | 24.991% | -0.034% | 0.773% | -2.30 | -1.03 | -0.094 | 4.88 | 11.96 | 51.5 | 7 | 8615.531–10007.976 | 2.37 | PASS |
| SPI25 | calibration-2 | 1000000 | 25.000% | 24.995% | -0.022% | 0.838% | 0.78 | 3.02 | -0.090 | 4.71 | 7.26 | 63.6 | 7 | 9704.095–10715.903 | 1.10 | PASS |
| SPI25 | calibration-3 | 1000000 | 25.000% | 24.999% | -0.005% | 0.434% | 0.28 | 0.26 | -0.092 | 4.52 | 13.11 | 86.4 | 6 | 9789.149–10613.349 | 0.95 | PASS |

Overall: **all runs within pre-registered bands**.

Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.
