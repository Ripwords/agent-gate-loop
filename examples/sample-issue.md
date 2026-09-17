# Discount codes take off cents instead of a percentage

Applying `SAVE10` to a $50.00 cart gives $49.90. It should give $45.00 (10% off).
`SAVE25` has the same problem and should give $37.50.

Totals are in cents and should be rounded to the nearest cent.
