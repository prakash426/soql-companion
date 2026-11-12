# Connection spike (Step 1b) findings

Date: 2026-11-12. Verified live against a dev org on API v68.0.
No credentials are stored in this repo. The spike token was used once
from a shell call and kept nowhere.

## Proven pattern

Auth: plain Bearer token in the Authorization header.
Calls used, both returned HTTP 200:

- GET /services/data/v68.0/sobjects/ (object inventory)
- GET /services/data/v68.0/sobjects/Account/describe (full shape)

Inventory returned 1842 objects. Account, Contact, Opportunity, Case
and User are all present and queryable.

## Describe to cache mapping (locked)

- objects: inventory entries where queryable is true.
- lookups: describe fields where type is reference. Each gives
  field name, referenceTo targets and relationshipName.
- children: describe childRelationships with a non null
  relationshipName. Each gives childSObject, field and
  relationshipName.
- fields: describe field names mapped to their type strings.

Account describe returned 70 fields, including OwnerId to User via
Owner and ParentId to Account via Parent, plus named child
collections. This matches the cache shape in the sample fixture.

## v1 rules from this

- Token paste plus Refresh Schema plus local cache, as planned.
- Polymorphic lookups (referenceTo with more than one target) resolve
  to the first target in v1 and raise a warning naming the others.
- Null relationshipName child entries are skipped, never guessed.
- Residual risk: this spike proves the REST pattern, not the
  in extension fetch. Final proof is the manual browser load in
  Step 7. If that fails, the fallback is file based snapshot import.
