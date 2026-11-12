# Step 1 spike findings (draft, moves into repo at Step 2)

Date: 2026-11-12. Parser: @jetstreamapp/soql-parser-js, installed fresh from npm.

## SOQL construct matrix

Result key: YES = parses and recomposes cleanly. GAP = parser rejects it.

```
#   construct                         result   notes for converter
1   simple select                     YES      baseline
2   child to parent dot field         YES      core of JOIN to SOQL path
3   parent to child subquery          YES      core of JOIN to SOQL path
4   WHERE LIKE plus LIMIT             YES      LIKE, LIMIT map directly
5   ORDER BY plus OFFSET plus NULLS   YES      NULLS LAST accepted
6   COUNT()                           YES      -
7   GROUP BY plus HAVING              YES      -
8   TYPEOF                            YES      Postgres/SQLite need CASE split, warn user
9   semi join (IN subquery)           YES      maps to SQL IN or EXISTS
10  anti join (NOT IN subquery)       YES      maps to SQL NOT IN
11  FORMULA() in WHERE                YES      only quoted form: FORMULA('A + B')
12  grandparent dot chain             YES      multi hop path resolution needed
13  date literal LAST_N_DAYS          YES      Postgres/SQLite need date math, warn user
14  boolean compare (= false)         YES      composer normalizes to FALSE
15  bare NOT, as in (NOT IsClosed)    GAP      parser rejects; flag with clear message
```

## Validation gate finding

isQueryValid alone is not reliable. It returned true for the known bad
string 'SELECT Id Foo FROM Baz'. v1 must gate on parseQuery inside
try/catch, and treat isQueryValid as a hint only.

## Cache JSON shape (proposal)

```
{
  "version": 1,
  "orgDomain": "example.my.salesforce.com",
  "fetchedAt": "2026-11-12T00:00:00Z",
  "objects": {
    "Account": {
      "fields": { "Id": "id", "Name": "string" },
      "lookups": [
        { "field": "OwnerId", "target": "User", "relationship": "Owner" }
      ],
      "children": [
        { "object": "Contact", "field": "AccountId", "relationship": "Contacts" }
      ]
    }
  }
}
```

Rules: lookups drive dot notation (Contact.Account.Name). Children drive
nested subqueries. Every SQL JOIN must resolve to a lookup or child hop,
else the converter stops with an alert naming the missing link.

## Still open in Step 1

Live connection spike against a real org. Needs org domain plus a session
token from the user. Proves the token plus schema read pattern from inside
the extension before any UI is built around it.
