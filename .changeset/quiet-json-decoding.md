---
'@insiderfinance/totalfinance': patch
---

Avoid rebuilding the freshly parsed JSON tree when restoring canonical artifacts. Non-finite
wrappers, prototype-sensitive keys, independent decoded results, and serialization rules are unchanged.
