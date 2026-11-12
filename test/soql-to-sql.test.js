import { test, expect } from 'vitest';
import { soqlToSql } from '../src/lib/soql-to-sql.js';

test('simple select with where and limit', () => {
  const out = soqlToSql(`SELECT Id, Name FROM Account WHERE Industry = 'Tech' LIMIT 10`, 'postgres');
  expect(out.sql).toBe(`SELECT Id, Name\nFROM Account\nWHERE Industry = 'Tech'\nLIMIT 10;`);
  expect(out.warnings).toEqual([]);
});

test('child to parent becomes a join with a guess warning', () => {
  const out = soqlToSql(`SELECT FirstName, Account.Name FROM Contact`, 'postgres');
  expect(out.sql).toBe(
    `SELECT FirstName, j1.Name\nFROM Contact\nLEFT JOIN Account AS j1 ON Contact.AccountId = j1.Id;`
  );
  expect(out.warnings).toHaveLength(1);
  expect(out.warnings[0]).toMatch(/Guessed JOIN/);
});

test('grandparent chain joins twice and resolves Owner to User', () => {
  const out = soqlToSql(`SELECT Account.Owner.Name FROM Contact`, 'sqlite');
  expect(out.sql).toBe(
    `SELECT j2.Name\nFROM Contact\nLEFT JOIN Account AS j1 ON Contact.AccountId = j1.Id\nLEFT JOIN User AS j2 ON j1.OwnerId = j2.Id;`
  );
  expect(out.warnings.join(' ')).toMatch(/Owner/);
});

test('parent to child subquery becomes a separate statement', () => {
  const out = soqlToSql(`SELECT Name, (SELECT LastName FROM Contacts) FROM Account`, 'postgres');
  expect(out.sql).toBe(`SELECT Name\nFROM Account;\n\nSELECT LastName\nFROM Contacts;`);
  expect(out.warnings.join(' ')).toMatch(/separate statement/);
});

test('group having order limit offset', () => {
  const out = soqlToSql(
    `SELECT LeadSource, COUNT(Id) c FROM Lead GROUP BY LeadSource HAVING COUNT(Id) > 1 ORDER BY LeadSource LIMIT 5 OFFSET 2`,
    'postgres'
  );
  expect(out.sql).toBe(
    `SELECT LeadSource, COUNT(Id) AS c\nFROM Lead\nGROUP BY LeadSource\nHAVING COUNT(Id) > 1\nORDER BY LeadSource\nLIMIT 5\nOFFSET 2;`
  );
  expect(out.warnings).toEqual([]);
});

test('like plus not null rewrite', () => {
  const out = soqlToSql(`SELECT Id FROM Contact WHERE LastName LIKE 'A%' AND Email != null`, 'sqlite');
  expect(out.sql).toBe(`SELECT Id\nFROM Contact\nWHERE LastName LIKE 'A%' AND Email IS NOT NULL;`);
});

test('semi join becomes inline IN subquery', () => {
  const out = soqlToSql(`SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)`, 'postgres');
  expect(out.sql).toBe(`SELECT Id\nFROM Account\nWHERE Id IN (SELECT AccountId FROM Contact);`);
});

test('date literal maps per dialect', () => {
  const pg = soqlToSql(`SELECT Id FROM Opportunity WHERE CloseDate = LAST_N_DAYS:30`, 'postgres');
  expect(pg.sql).toBe(`SELECT Id\nFROM Opportunity\nWHERE CloseDate >= CURRENT_DATE - INTERVAL '30 days';`);
  const lite = soqlToSql(`SELECT Id FROM Opportunity WHERE CloseDate = LAST_N_DAYS:30`, 'sqlite');
  expect(lite.sql).toBe(`SELECT Id\nFROM Opportunity\nWHERE CloseDate >= date('now', '-30 days');`);
  expect(pg.warnings.join(' ')).toMatch(/Date literal/);
});

test('nulls ordering warns on sqlite only', () => {
  const pg = soqlToSql(`SELECT Name FROM Account ORDER BY Name DESC NULLS LAST`, 'postgres');
  expect(pg.warnings).toEqual([]);
  const lite = soqlToSql(`SELECT Name FROM Account ORDER BY Name DESC NULLS LAST`, 'sqlite');
  expect(lite.sql).toContain('NULLS LAST');
  expect(lite.warnings).toHaveLength(1);
});

test('typeof expands one column per branch', () => {
  const out = soqlToSql(`SELECT TYPEOF What WHEN Account THEN Name ELSE Id END FROM Task`, 'postgres');
  expect(out.sql).toBe(`SELECT What_Account_Name, What_Id\nFROM Task;`);
  expect(out.warnings.join(' ')).toMatch(/TYPEOF/);
});

test('formula in where becomes an arithmetic expression', () => {
  const out = soqlToSql(`SELECT Id FROM Opportunity WHERE FORMULA('Amount + Discount__c') > 100`, 'postgres');
  expect(out.sql).toBe(`SELECT Id\nFROM Opportunity\nWHERE (Amount + Discount__c) > 100;`);
});

test('bare count becomes count star', () => {
  const out = soqlToSql(`SELECT COUNT() FROM Contact`, 'postgres');
  expect(out.sql).toBe(`SELECT COUNT(*)\nFROM Contact;`);
});

test('invalid soql throws a clear error', () => {
  expect(() => soqlToSql(`SELECT FROM WHERE`, 'postgres')).toThrow(/Invalid SOQL/);
});

test('unknown dialect throws', () => {
  expect(() => soqlToSql(`SELECT Id FROM Account`, 'mysql')).toThrow(/dialect/);
});
