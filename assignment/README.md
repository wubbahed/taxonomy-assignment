# Aviary Taxonomies Take-Home

## Background

Aviary models flexible data using:

- **Taxonomies**: schemas that define fields and relationships
- **Entities**: records that belong to a taxonomy and store values for that taxonomy's fields
- **Relationships**: traversable links from one taxonomy to another based on field matching rules

In the real product, these concepts drive workflow automation, data views, reporting, and cross-record traversal. The flexible data storage system is a core component to how Aviary supports many complex healthcare operations workflows.

## Assignment

Build a small HTTP service that:

- loads taxonomy and entity fixtures from disk on startup
- supports CRUD for taxonomies
- supports CRUD for entities
- exposes relationship graph traversal for taxonomies
- exposes nested and flattened entity data traversal
- resolves dot-notation field paths across relationships
- wherever the assignment is unclear or ambiguous, use your best judgment

The required HTTP endpoints and behavior are defined in [api-contract.md](api-contract.md).

We'll dicuss your implementation, tradeoffs and possible future feature extensions in a follow-up conversation.

## Constraints

- Your service must read fixtures from `FIXTURE_DIR`.
- Your service must listen on `PORT`.
- All responses must be JSON.
- You may choose to use a real database (of your choosing) or keep in memory persistence as you prefer.
- _*You may use any language or framework.*_
- _*You may use any AI tools you're comfortable with.*_

## What We Will Provide

- [public taxonomies fixture](fixtures/public/taxonomies.json)
- [public entities fixture](fixtures/public/entities.json)
- this prompt
- the HTTP contract [api-contract.md](api-contract.md)

We also maintain a **private valid fixture set** with additional edge cases. We will use that during evaluation, so your implementation should work against the fixture schema, not just the exact public values.

## What To Submit

Submit a _private_ repo or zip file containing:

- your implementation
- tests
- a `README.md` with build/run instructions, including running tests
- either:
  - Docker instructions, or
  - local build instructions
- example commands for calling the service
- a note describing assumptions and tradeoffs
- a brief note describing how you would extend your service to handle richer features. Some features you may choose to consider:
  - How would you present taxonomies to users? What about entities?
  - Richer field types such as `enum`, `email`, `phone_number`
  - How would you implement cohorting/querying of entities?
  - How would you handle validation and uniqueness constraints?
  - How would you handle taxonomy schema evolutions?
  - Indexing and caching strategies?

## Evaluation

We care about:

- code structure and clarity
- test quality
- correctness against the documented contract
- handling of relationship traversal edge cases
- thoughtful handling of ambiguity

We do not require:

- auth
- a UI
- production-grade persistence

## Timebox

The intended core is roughly 3-4 hours. You may choose to spend more time polishing, but we are not expecting a production-grade service. We are looking to get insight into how you think about problems core to what we do at Aviary.
