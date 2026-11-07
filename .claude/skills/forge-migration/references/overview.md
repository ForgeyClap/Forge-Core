# forge-migration — domain overview

The governing principle is **Michael Feathers' rule: you cannot safely change code you cannot characterize.** Migration is not a rewrite — it is a sequence of small, reversible, parity-verified swaps behind a facade, each of which keeps the system working the whole time. The catastrophic failure mode is the "big-bang" rewrite that goes dark for months and cuts over into unverified behavior loss. Forge does not do that.
