# SOQL Companion

Browser extension that converts SOQL to SQL (Postgres, SQLite) and back,
with org relationship checks.

Status: Step 2 scaffold. The converter lands in Steps 3 to 5.

## Layout

src/ holds the extension shell. test/ holds maintained checks. fixtures/
holds the sample schema. docs/ holds the spike matrix.

## Scripts

npm test runs checks. npm run build produces dist/chrome and
dist/firefox. npm run lint checks style.

## Privacy

Queries and tokens never leave the browser except for schema reads you
trigger.
