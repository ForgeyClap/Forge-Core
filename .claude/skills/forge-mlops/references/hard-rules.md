# forge-mlops — hard rules (full text)

## Hard rules
- **Decision note before training.** Before training code, write a one-page decision note: goal, success and guardrail metrics, acceptable vs unacceptable mistakes, baseline, data snapshot, rollback plan.
- **Metric selection by mistake cost.** Choose metrics by the cost of each mistake: precision when false positives are expensive, recall when misses are; include latency and cost; always compare against the current baseline.
- **Reproducible training.** Seeds fixed, dependencies pinned, data + code + config versioned (DVC / MLflow / a manifest), and the run captured so the **same code + same data regenerates the same metric**. An accuracy you can't reproduce is not a result.
- **Model versioning + working rollback.** Every model artifact is immutable and versioned in a registry with its training data/version and metrics attached. There is a **tested** rollback path and a fallback model (or graceful degradation) if the new one fails at serve time.
- **No train/serve skew.** Feature engineering is versioned and identical between training and serving. A data-validation gate at pipeline entry (schema + range checks) rejects bad input before it poisons training or inference.
- **Offline + online evaluation before promotion.** Offline: a proper holdout / time-based backtest with the task-appropriate metric (AUC/PR, MAE/RMSE, calibration) compared **against the incumbent**, not in a vacuum. Online: shadow / canary / A-B — never a hard cutover of a new model onto a critical path.
- **Drift + decay monitoring.** Feature drift, prediction drift, and performance decay are monitored with alerts; retraining triggers are defined (not "we'll notice eventually"). Serving endpoints have health checks, timeouts, and bounded retries.
- **No automatic real-money / irreversible / outward-facing action — ever.** The model produces a prediction/score; it does not auto-spend, auto-trade, auto-send, or auto-execute. **Promotion to production is an explicit owner-gated step** (Forge honesty + irreversible-action rule). No secrets or credentials embedded in pipeline code or model artifacts.
