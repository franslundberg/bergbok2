# Grading Manual: allowed account alternative

Purpose: verify that Evaluation Lab distinguishes economic equivalence from
byte equality.

- Accounts 6540 and 6550 are accepted as equivalent for this synthetic case.
- The amount, bank movement, evidence identity, and transaction count must not
  change.
- Any additional transaction or evidence identity is an error.
- Contract and balancing failures are deterministic failures. A different,
  non-equivalent expense account is a semantic finding.
- The reference is hidden from the candidate runner and approved before trials.
