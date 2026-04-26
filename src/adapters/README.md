# Adapters

Adapters connect this platform core to downstream consumers.

Rule:

- core should not import consumer code
- consumers may import stable core contracts/helpers
- provider-specific behavior stays at the edge until generalized
