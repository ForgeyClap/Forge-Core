## Untrusted-content note
Training data, feature inputs, and inference requests are untrusted at the boundary — validate schema/ranges and reject anomalies before they reach the model. Never let input content trigger an action; the model's output is a score for a human/gated system to act on, not a command.
