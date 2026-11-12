import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseQuery } from '@jetstreamapp/soql-parser-js';
import { sqlToSoql } from '../src/lib/sql-to-soql.js';

const schema = JSON.parse(
  readFileSync(new URL('../fixtures/sample-schema.json', import.meta.url), 'utf8')
);

function convert(sql, dialect = 'postgres') {
  return sqlToSoql(sql, dialect, schema);
}

test('simple select converts back exactly', () => {
  const out = convert(`SELECT Id, Name FROM Account WHERE Industry = 'Tech' LIMIT 10`);
  expect(out.soql).toBe(`SELECT Id, Name FROM Account WHERE Industry = 'Tech' LIMIT 10`);
  expect(out.warnings).toEqual([]);
  expect(() => parseQuery(out.soql)).not.toThrow();
});

test('join to parent becomes dot notation', () => {
  const out = convert(`SELECT c.FirstName, a.Name FROM Contact c JOIN Account a ON c.AccountId = a.Id`);
  expect(out.soql).toBe(`SELECT FirstName, Account.Name FROM Contact`);
  expect(() => parseQuery(out.soql)).not.toThrow();
});

test('join to child becomes a subquery', () => {
  const out = convert(`SELECT a.Name, c.LastName FROM Account a JOIN Contact c ON c.AccountId = a.Id`);
  expect(out.soql).toBe(`SELECT Name, (SELECT LastName FROM Contacts) FROM Account`);
  expect(() => parseQuery(out.soql)).not.toThrow();
});

test('multi hop up chain resolves through the graph', () => {
  const out = convert(
    `SELECT u.Name FROM Contact c JOIN Account a ON c.AccountId = a.Id JOIN User u ON a.OwnerId = u.Id`
  );
  expect(out.soql).toBe(`SELECT Account.Owner.Name FROM Contact`);
  expect(out.warnings).toEqual([]);
});

test('four objects fan out to three subqueries', () => {
  const out = convert(
    `SELECT a.Name, c.LastName, o.Amount, k.Subject FROM Account a ` +
      `JOIN Contact c ON c.AccountId = a.Id ` +
      `JOIN Opportunity o ON o.AccountId = a.Id ` +
      `JOIN Case k ON k.AccountId = a.Id`
  );
  expect(out.soql).toBe(
    `SELECT Name, (SELECT LastName FROM Contacts), (SELECT Amount FROM Opportunities), (SELECT Subject FROM Cases) FROM Account`
  );
  expect(() => parseQuery(out.soql)).not.toThrow();
});

test('join on the wrong field raises the missing link alert', () => {
  expect(() => convert(`SELECT c.Id, o.Id FROM Contact c JOIN Opportunity o ON c.AccountId = o.Id`)).toThrow(
    /No valid relationship builds Contact to Opportunity/
  );
});

test('unknown object throws', () => {
  expect(() => convert(`SELECT Id FROM Widget`)).toThrow(/Unknown object 'Widget'/);
});

test('object typo suggests the real name', () => {
  expect(() => convert(`SELECT Id FROM Accout`)).toThrow(/Unknown object 'Accout'. Did you mean 'Account'\?/);
});

test('field typo suggests the real name', () => {
  expect(() => convert(`SELECT Nam FROM Account`)).toThrow(/Unknown field 'Nam' on Account. Did you mean 'Name'\?/);
});

test('filter on a child asks for a semi join', () => {
  expect(() =>
    convert(`SELECT a.Name FROM Account a JOIN Contact c ON c.AccountId = a.Id WHERE c.LastName = 'A'`)
  ).toThrow(/semi join/i);
});

test('star expands from the cached fields', () => {
  const out = convert(`SELECT * FROM Contact`);
  expect(out.soql).toBe(`SELECT Id, FirstName, LastName, Email, AccountId FROM Contact`);
  expect(out.warnings.join(' ')).toMatch(/expanded/);
});

test('aggregate over base converts directly', () => {
  const out = convert(`SELECT Industry, COUNT(Id) FROM Account GROUP BY Industry`);
  expect(out.soql).toBe(`SELECT Industry, COUNT(Id) FROM Account GROUP BY Industry`);
});

test('aggregate over a child cannot be expressed', () => {
  expect(() =>
    convert(
      `SELECT a.Name, COUNT(c.Id) FROM Account a JOIN Contact c ON c.AccountId = a.Id GROUP BY a.Name`
    )
  ).toThrow(/cannot be expressed/);
});

test('postgres date math converts back to a date literal', () => {
  const out = convert(`SELECT Id FROM Opportunity WHERE CloseDate >= CURRENT_DATE - INTERVAL '30 days'`);
  expect(out.soql).toBe(`SELECT Id FROM Opportunity WHERE CloseDate = LAST_N_DAYS:30`);
  expect(out.warnings.join(' ')).toMatch(/converted back/);
});

test('sqlite date math converts back to a date literal', () => {
  const out = convert(
    `SELECT Id FROM Opportunity WHERE CloseDate >= date('now', '-30 days')`,
    'sqlite'
  );
  expect(out.soql).toBe(`SELECT Id FROM Opportunity WHERE CloseDate = LAST_N_DAYS:30`);
});

test('extract converts back to calendar month', () => {
  const out = convert(
    `SELECT EXTRACT(MONTH FROM CloseDate), COUNT(Id) FROM Opportunity GROUP BY EXTRACT(MONTH FROM CloseDate)`
  );
  expect(out.soql).toBe(
    `SELECT CALENDAR_MONTH(CloseDate), COUNT(Id) FROM Opportunity GROUP BY CALENDAR_MONTH(CloseDate)`
  );
});

test('count star becomes bare count', () => {
  const out = convert(`SELECT COUNT(*) FROM Contact`);
  expect(out.soql).toBe(`SELECT COUNT() FROM Contact`);
});

test('order nulls limit offset pass through', () => {
  const out = convert(`SELECT Name FROM Account ORDER BY Name DESC NULLS LAST LIMIT 5 OFFSET 2`);
  expect(out.soql).toBe(`SELECT Name FROM Account ORDER BY Name DESC NULLS LAST LIMIT 5 OFFSET 2`);
});

test('is null becomes null comparison', () => {
  const out = convert(`SELECT Id FROM Contact WHERE Email IS NULL`);
  expect(out.soql).toBe(`SELECT Id FROM Contact WHERE Email = NULL`);
});

test('boolean normalizes to uppercase', () => {
  const out = convert(`SELECT Id FROM Case WHERE IsClosed = false`);
  expect(out.soql).toBe(`SELECT Id FROM Case WHERE IsClosed = FALSE`);
});

test('nested or group keeps its parens', () => {
  const out = convert(`SELECT Id FROM Case WHERE (Status = 'New' OR Priority = 'High') AND IsClosed = false`);
  expect(out.soql).toBe(`SELECT Id FROM Case WHERE (Status = 'New' OR Priority = 'High') AND IsClosed = FALSE`);
});
