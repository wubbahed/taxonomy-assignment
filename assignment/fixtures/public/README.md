# Public Fixtures

This directory contains the public fixture set that candidates receive.

## Files

- [taxonomies.json](taxonomies.json)
- [entities.json](entities.json)

## Intentional Coverage

The public fixture set includes:

- direct field access
- `to_one` traversal
- `to_many` traversal
- `to_many_through` traversal
- multi-hop traversal
- archived related entities
- a composite-key relationship with multiple `match` clauses
- mixed field types: `string`, `integer`, `boolean`, `float`, `date`, `datetime`

The private fixture set will extend this with additional valid cases.

## Fixture Notes

- Taxonomy relationships are directional.
- A `match` array can contain one or more field mappings.
- All mappings in a relationship's `match` array must match for the relationship to resolve.
- A `to_many_through` relationship composes existing relationship keys via a `through` array.
- Entity `attributes` are keyed by taxonomy field key.
- `archived: true` means the entity or taxonomy should be considered inactive for default listing and traversal.
