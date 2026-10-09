# Semantic question corpus

The 37 synthetic questions exercise deterministic retrieval against real outputs from the Express, routing-controllers, and Swagger 2 analyzers. They include distinct actions, ambiguous invoice operations, wrong-action lexical decoys, and partial coverage. Expected route lists and order are hand-authored.

The deterministic provider in the test is a scripted fixture, not a relevance judge. It verifies request pinning, result-shape and citation checks, and no-context behavior; it never calls a model or network service. These tests do not measure live model quality or establish a semantic accuracy rate.

The corpus checks retrieval within a selected contract. `no_match` means no keyword match in that selected searchable context; it does not claim that an API is absent. Real analyzer outputs currently carry partial coverage warnings, which the expected results preserve. One closed-contract case explicitly creates a test projection of parsed route declarations to exercise the scoped complete `no_match` branch; that projection does not change or assert analyzer coverage. Partial source coverage remains incomplete or unknown, and semantic suggestions remain inferred and unreviewed.
