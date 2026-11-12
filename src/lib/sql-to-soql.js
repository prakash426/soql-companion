import { parseQuery, composeQuery } from '@jetstreamapp/soql-parser-js';

function fail(message) {
  return new Error(message);
}

const CLAUSE_WORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'USING',
  'AND', 'OR', 'NOT', 'AS', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST',
  'IN', 'LIKE', 'IS', 'NULL', 'UNION', 'EXCEPT', 'INTERSECT', 'BY',
]);

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const isDigit = (c) => c >= '0' && c <= '9';
  const isWordStart = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c === '$';
  const isWordChar = (c) => isWordStart(c) || isDigit(c);
  while (i < n) {
    const c = input[i];
    if (isSpace(c)) {
      i += 1;
      continue;
    }
    if (c === '-' && input[i + 1] === '-') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      if (end === -1) throw fail('Unterminated comment.');
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (j >= n) throw fail('Unterminated string.');
      tokens.push({ type: 'string', raw: input.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && input[j] !== '"') j += 1;
      if (j >= n) throw fail('Unterminated identifier.');
      tokens.push({ type: 'word', raw: input.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
      let j = i;
      while (j < n && (isDigit(input[j]) || input[j] === '.')) j += 1;
      tokens.push({ type: 'number', raw: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i;
      while (j < n && isWordChar(input[j])) j += 1;
      tokens.push({ type: 'word', raw: input.slice(i, j) });
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '<>' || two === '!=') {
      tokens.push({ type: 'op', raw: two });
      i += 2;
      continue;
    }
    if (c === '.') {
      tokens.push({ type: 'dot', raw: '.' });
      i += 1;
      continue;
    }
    if (c === ',' || c === '(' || c === ')' || c === ';') {
      tokens.push({ type: 'punct', raw: c });
      i += 1;
      continue;
    }
    if (c === '=' || c === '<' || c === '>' || c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ type: 'op', raw: c });
      i += 1;
      continue;
    }
    throw fail(`Unexpected character '${c}'.`);
  }
  tokens.push({ type: 'eof', raw: '' });
  return tokens;
}

class Reader {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    return this.tokens[this.pos++];
  }
  isWord(...words) {
    const t = this.peek();
    return t.type === 'word' && words.some((w) => t.raw.toUpperCase() === w);
  }
  eatWord(...words) {
    if (!this.isWord(...words)) throw fail(`Expected ${words.join(' or ')}, found '${this.peek().raw}'.`);
    return this.next().raw;
  }
  eatPunct(ch) {
    const t = this.peek();
    if (t.type !== 'punct' || t.raw !== ch) throw fail(`Expected '${ch}', found '${t.raw}'.`);
    return this.next().raw;
  }
  eatIdent() {
    const t = this.peek();
    if (t.type !== 'word') throw fail(`Expected a name, found '${t.raw}'.`);
    return this.next().raw;
  }
}

function parseSelect(r) {
  r.eatWord('SELECT');
  let distinct = false;
  if (r.isWord('DISTINCT')) {
    r.next();
    distinct = true;
  }
  const select = parseSelectList(r);
  r.eatWord('FROM');
  const from = parseTableRef(r);
  const joins = [];
  while (isJoinStart(r)) joins.push(parseJoin(r));
  let where = null;
  let groupBy = null;
  let having = null;
  let orderBy = null;
  let limit = null;
  let offset = null;
  if (r.isWord('WHERE')) {
    r.next();
    where = parseOr(r);
  }
  if (r.isWord('GROUP')) {
    r.next();
    r.eatWord('BY');
    groupBy = parseOperandList(r);
  }
  if (r.isWord('HAVING')) {
    r.next();
    having = parseOr(r);
  }
  if (r.isWord('ORDER')) {
    r.next();
    r.eatWord('BY');
    orderBy = parseOrderList(r);
  }
  if (r.isWord('LIMIT')) {
    r.next();
    limit = parseLimit(r);
  }
  if (r.isWord('OFFSET')) {
    r.next();
    offset = parseCount(r);
  }
  const tail = r.peek();
  if (tail.type !== 'eof' && !(tail.type === 'punct' && tail.raw === ';')) {
    throw fail(`'${tail.raw}' starts a clause this version cannot express.`);
  }
  return { distinct, select, from, joins, where, groupBy, having, orderBy, limit, offset };
}

function parseSelectList(r) {
  if (r.peek().type === 'op' && r.peek().raw === '*') {
    r.next();
    return [{ kind: 'star', table: null }];
  }
  const items = [];
  while (true) {
    const t = r.peek();
    const t2 = r.tokens[r.pos + 1];
    const t3 = r.tokens[r.pos + 2];
    if (
      t.type === 'word' &&
      t2 && t2.type === 'dot' &&
      t3 && t3.type === 'op' && t3.raw === '*'
    ) {
      items.push({ kind: 'star', table: r.next().raw });
      r.next();
      r.next();
    } else {
      const expr = parseSelectExpr(r);
      let alias = null;
      if (r.isWord('AS')) {
        r.next();
        alias = r.eatIdent();
      } else if (r.peek().type === 'word' && !CLAUSE_WORDS.has(r.peek().raw.toUpperCase())) {
        alias = r.next().raw;
      }
      items.push({ kind: 'expr', expr, alias });
    }
    if (r.peek().type === 'punct' && r.peek().raw === ',') {
      r.next();
      continue;
    }
    return items;
  }
}

function parseSelectExpr(r) {
  const t = r.peek();
  const t2 = r.tokens[r.pos + 1];
  if (t.type === 'word' && t2 && t2.type === 'punct' && t2.raw === '(') return parseCall(r);
  if (t.type === 'word') return parseDotted(r);
  throw fail(`'${t.raw}' in SELECT cannot be expressed in SOQL.`);
}

function parseTableRef(r) {
  const t = r.peek();
  if (t.type === 'punct' && t.raw === '(') {
    throw fail('Subqueries in FROM cannot be expressed in SOQL.');
  }
  const name = r.eatIdent();
  let alias = null;
  if (r.isWord('AS')) {
    r.next();
    alias = r.eatIdent();
  } else if (r.peek().type === 'word' && !CLAUSE_WORDS.has(r.peek().raw.toUpperCase())) {
    alias = r.next().raw;
  }
  return { name, alias: alias || name };
}

function isJoinStart(r) {
  return r.isWord('JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS');
}

function parseJoin(r) {
  let kind = 'INNER';
  if (r.isWord('INNER')) {
    r.next();
  } else if (r.isWord('LEFT', 'RIGHT', 'FULL', 'CROSS')) {
    kind = r.next().raw.toUpperCase();
    if (r.isWord('OUTER')) r.next();
  }
  r.eatWord('JOIN');
  const table = parseTableRef(r);
  r.eatWord('ON');
  const left = parseOperand(r);
  const op = r.peek();
  if (op.type !== 'op' || op.raw !== '=') throw fail('JOIN condition must be a plain equality.');
  r.next();
  const right = parseOperand(r);
  return { kind, table, on: { left, right } };
}

function parseOperandList(r) {
  const items = [];
  while (true) {
    items.push(parseOperand(r));
    if (r.peek().type === 'punct' && r.peek().raw === ',') {
      r.next();
      continue;
    }
    return items;
  }
}

function parseOrderList(r) {
  const items = [];
  while (true) {
    const value = parseOperand(r);
    let dir = null;
    let nulls = null;
    if (r.isWord('ASC', 'DESC')) dir = r.next().raw.toUpperCase();
    if (r.isWord('NULLS')) {
      r.next();
      nulls = r.eatWord('FIRST', 'LAST').toUpperCase();
    }
    items.push({ value, dir, nulls });
    if (r.peek().type === 'punct' && r.peek().raw === ',') {
      r.next();
      continue;
    }
    return items;
  }
}

function parseLimit(r) {
  const t = r.peek();
  if (t.type === 'number') {
    r.next();
    return { count: t.raw };
  }
  if (t.type === 'word' && t.raw.toUpperCase() === 'ALL') {
    r.next();
    return { all: true };
  }
  throw fail('LIMIT needs a number.');
}

function parseCount(r) {
  const t = r.peek();
  if (t.type !== 'number') throw fail('Expected a number.');
  r.next();
  return t.raw;
}

function parseOr(r) {
  let left = parseAnd(r);
  while (r.isWord('OR')) {
    r.next();
    left = { kind: 'logic', op: 'OR', left, right: parseAnd(r) };
  }
  return left;
}

function parseAnd(r) {
  let left = parseNot(r);
  while (r.isWord('AND')) {
    r.next();
    left = { kind: 'logic', op: 'AND', left, right: parseNot(r) };
  }
  return left;
}

function parseNot(r) {
  if (r.isWord('NOT')) {
    throw fail('Bare NOT cannot be expressed by this version yet. Rewrite without it.');
  }
  return parsePredicate(r);
}

function parsePredicate(r) {
  const left = parseOperand(r);
  if (left.kind === 'group') return left;
  if (r.isWord('IS')) {
    r.next();
    let neg = false;
    if (r.isWord('NOT')) {
      r.next();
      neg = true;
    }
    if (r.isWord('DISTINCT')) throw fail('IS DISTINCT FROM cannot be expressed in SOQL.');
    r.eatWord('NULL');
    return { kind: 'isnull', neg, target: left };
  }
  if (r.isWord('NOT')) {
    r.next();
    if (r.isWord('IN')) {
      r.next();
      return parseInList(r, left, true);
    }
    throw fail('NOT LIKE cannot be expressed by this version yet.');
  }
  if (r.isWord('IN')) {
    r.next();
    return parseInList(r, left, false);
  }
  if (r.isWord('LIKE')) {
    r.next();
    return { kind: 'compare', op: 'LIKE', left, right: parseOperand(r) };
  }
  const t = r.peek();
  if (t.type === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(t.raw)) {
    r.next();
    return { kind: 'compare', op: t.raw, left, right: parseOperand(r) };
  }
  throw fail('Expected a comparison after the WHERE value.');
}

function parseInList(r, left, neg) {
  r.eatPunct('(');
  if (r.isWord('SELECT')) throw fail('Subqueries in WHERE cannot be expressed by this version yet.');
  if (r.peek().type === 'punct' && r.peek().raw === ')') throw fail('IN needs at least one value.');
  const items = [];
  while (true) {
    items.push(parseOperand(r));
    if (r.peek().type === 'punct' && r.peek().raw === ',') {
      r.next();
      continue;
    }
    break;
  }
  r.eatPunct(')');
  return { kind: 'in', neg, target: left, items };
}

function parseOperand(r) {
  let node = parsePrimary(r);
  while (r.peek().type === 'op' && ['+', '-', '*', '/'].includes(r.peek().raw)) {
    const op = r.next().raw;
    node = { kind: 'binary', op, left: node, right: parsePrimary(r) };
  }
  return node;
}

function parsePrimary(r) {
  const t = r.peek();
  if (t.type === 'punct' && t.raw === '(') {
    r.next();
    if (r.isWord('SELECT')) throw fail('Subqueries in WHERE cannot be expressed by this version yet.');
    const expr = parseOr(r);
    r.eatPunct(')');
    return { kind: 'group', expr };
  }
  if (t.type === 'string') {
    r.next();
    return { kind: 'literal', value: t.raw, literalType: 'STRING' };
  }
  if (t.type === 'number') {
    r.next();
    return { kind: 'literal', value: t.raw, literalType: t.raw.includes('.') ? 'DECIMAL' : 'INTEGER' };
  }
  if (t.type === 'word') {
    const up = t.raw.toUpperCase();
    if (up === 'TRUE' || up === 'FALSE') {
      r.next();
      return { kind: 'literal', value: up, literalType: 'BOOLEAN' };
    }
    if (up === 'NULL') {
      r.next();
      return { kind: 'literal', value: 'NULL', literalType: 'NULL' };
    }
    if (up === 'CURRENT_DATE') {
      r.next();
      return { kind: 'currentDate' };
    }
    if (up === 'INTERVAL') {
      r.next();
      const amount = r.peek();
      if (amount.type !== 'string') throw fail('INTERVAL needs a quoted amount such as days.');
      r.next();
      return { kind: 'interval', value: amount.raw };
    }
    const t2 = r.tokens[r.pos + 1];
    if (t2 && t2.type === 'punct' && t2.raw === '(') return parseCall(r);
    return parseDotted(r);
  }
  throw fail(`'${t.raw}' cannot be expressed in SOQL.`);
}

function parseDotted(r) {
  const parts = [r.eatIdent()];
  while (r.peek().type === 'dot') {
    r.next();
    parts.push(r.eatIdent());
  }
  if (parts.length > 2) throw fail(`'${parts.join('.')}' has too many parts for SOQL.`);
  return { kind: 'col', parts };
}

function parseCall(r) {
  const name = r.eatIdent().toUpperCase();
  r.eatPunct('(');
  if (r.isWord('DISTINCT')) throw fail(`DISTINCT inside ${name} cannot be expressed in SOQL.`);
  if (name === 'COUNT' && r.peek().type === 'op' && r.peek().raw === '*') {
    r.next();
    r.eatPunct(')');
    return { kind: 'call', name: 'COUNT', args: [{ kind: 'star' }] };
  }
  if (name === 'EXTRACT') {
    const part = r.eatIdent().toUpperCase();
    r.eatWord('FROM');
    const col = parseOperand(r);
    r.eatPunct(')');
    return { kind: 'extract', part, col };
  }
  const args = [];
  if (!(r.peek().type === 'punct' && r.peek().raw === ')')) {
    while (true) {
      args.push(parseCallArg(r));
      if (r.peek().type === 'punct' && r.peek().raw === ',') {
        r.next();
        continue;
      }
      break;
    }
  }
  r.eatPunct(')');
  return { kind: 'call', name, args };
}

function parseCallArg(r) {
  const t = r.peek();
  if (t.type === 'string') {
    r.next();
    return { kind: 'literal', value: t.raw, literalType: 'STRING' };
  }
  if (t.type === 'number') {
    r.next();
    return { kind: 'literal', value: t.raw, literalType: t.raw.includes('.') ? 'DECIMAL' : 'INTEGER' };
  }
  if (t.type === 'word') {
    const up = t.raw.toUpperCase();
    if (up === 'TRUE' || up === 'FALSE') {
      r.next();
      return { kind: 'literal', value: up, literalType: 'BOOLEAN' };
    }
    if (up === 'NULL') {
      r.next();
      return { kind: 'literal', value: 'NULL', literalType: 'NULL' };
    }
    const t2 = r.tokens[r.pos + 1];
    if (t2 && t2.type === 'punct' && t2.raw === '(') return parseCall(r);
    return parseDotted(r);
  }
  throw fail(`'${t.raw}' cannot be used as a function argument here.`);
}

export function sqlToSoql(sql, dialect, schema) {
  if (dialect !== 'postgres' && dialect !== 'sqlite') {
    throw fail(`Unknown dialect '${dialect}'. Use postgres or sqlite.`);
  }
  if (!schema || typeof schema !== 'object' || !schema.objects) {
    throw fail('No schema loaded. Connect your org or load the sample schema.');
  }
  const ast = parseSelect(new Reader(tokenize(sql)));
  const warnings = new Set();
  if (ast.distinct) warnings.add('DISTINCT dropped. SOQL has no DISTINCT.');
  const tables = new Map();
  const register = (ref) => {
    const object = findObject(schema, ref.name);
    const key = ref.alias.toLowerCase();
    if (tables.has(key)) throw fail(`Duplicate alias '${ref.alias}'.`);
    tables.set(key, { object, alias: ref.alias });
  };
  register(ast.from);
  for (const join of ast.joins) {
    if (join.kind !== 'INNER' && join.kind !== 'LEFT') {
      warnings.add(`${join.kind} JOIN treated as LEFT JOIN.`);
    }
    register(join.table);
  }
  const seenObjects = new Set();
  for (const t of tables.values()) {
    if (seenObjects.has(t.object)) throw fail(`Joining ${t.object} to itself cannot be expressed in SOQL.`);
    seenObjects.add(t.object);
  }
  const base = tables.get(ast.from.alias.toLowerCase());
  const placed = new Map();
  placed.set(base.object, { kind: 'base', dot: [], alias: base.alias });
  for (const join of ast.joins) {
    const target = tables.get(join.table.alias.toLowerCase());
    placed.set(target.object, resolveJoinPath(schema, base.object, target, join, tables));
  }
  const builder = { schema, tables, placed, base, warnings, dialect, ast, aliasMap: new Map() };
  const fields = buildFields(ast, builder);
  const query = { sObject: base.object, fields };
  if (ast.where) query.where = chainize(convertCond(ast.where, builder, 'WHERE'));
  if (ast.groupBy) query.groupBy = ast.groupBy.map((g) => convertGroupItem(g, builder));
  if (ast.having) query.having = chainize(convertCond(ast.having, builder, 'HAVING'));
  if (ast.orderBy) query.orderBy = ast.orderBy.map((o) => convertOrderItem(o, builder));
  if (ast.limit && !ast.limit.all) query.limit = toCount(ast.limit.count, 'LIMIT');
  if (ast.limit && ast.limit.all) warnings.add('LIMIT ALL dropped. SOQL reads to the platform limit.');
  if (ast.offset) query.offset = toCount(ast.offset, 'OFFSET');
  let soql;
  try {
    soql = composeQuery(query);
  } catch (err) {
    throw fail(`Could not build SOQL: ${(err && err.message) || err}`);
  }
  try {
    parseQuery(soql);
  } catch (err) {
    throw fail(`Built SOQL failed validation: ${(err && err.message) || err} Got: ${soql}`);
  }
  return { soql, warnings: [...warnings] };
}

function findObject(schema, name) {
  if (schema.objects[name]) return name;
  const lower = name.toLowerCase();
  const exact = Object.keys(schema.objects).find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  throw fail(`Unknown object '${name}'.` + suggestName(name, Object.keys(schema.objects)));
}

function assertField(schema, object, field) {
  if (!schema.objects[object].fields[field]) {
    throw fail(`Unknown field '${field}' on ${object}.` + suggestName(field, Object.keys(schema.objects[object].fields)));
  }
}

function resolveJoinPath(schema, baseName, target, join, tables) {
  const on = describeOn(join, tables, schema);
  const path = findPath(schema, baseName, target.object);
  if (!path) {
    throw fail(`No valid relationship builds ${baseName} to ${target.object} on ${on.text}. Check the lookup field and try again.`);
  }
  const last = path[path.length - 1];
  const touchesTarget = [on.a, on.b].some((s) => s.alias.toLowerCase() === target.alias.toLowerCase());
  if (!touchesTarget) throw fail(`JOIN on ${target.object} must reference ${target.alias} in its ON clause.`);
  if (!hopMatches(last, on)) {
    throw fail(`No valid relationship builds ${baseName} to ${target.object} on ${on.text}. Check the lookup field and try again.`);
  }
  const downs = path.filter((h) => h.dir === 'down');
  if (downs.length > 1 || (downs.length === 1 && path.length > 1)) {
    throw fail(`Path from ${baseName} to ${target.object} needs nesting this version cannot express. Query one level at a time.`);
  }
  if (downs.length === 1) return { kind: 'down', childRel: downs[0].rel, alias: target.alias };
  return { kind: 'up', dot: path.map((h) => h.rel), alias: target.alias };
}

function describeOn(join, tables, schema) {
  const text = `${operandText(join.on.left)} = ${operandText(join.on.right)}`;
  return { a: onSide(join.on.left, tables, schema), b: onSide(join.on.right, tables, schema), text };
}

function operandText(node) {
  if (node && node.kind === 'col') return node.parts.join('.');
  return '?';
}

function onSide(node, tables, schema) {
  if (!node || node.kind !== 'col') throw fail('JOIN condition must compare two table columns.');
  if (node.parts.length === 2) {
    const entry = tables.get(node.parts[0].toLowerCase());
    if (!entry) throw fail(`Unknown alias '${node.parts[0]}' in JOIN condition.`);
    assertField(schema, entry.object, node.parts[1]);
    return { alias: entry.alias, object: entry.object, col: node.parts[1] };
  }
  const matches = [...tables.values()].filter((t) => schema.objects[t.object].fields[node.parts[0]]);
  if (matches.length === 1) return { alias: matches[0].alias, object: matches[0].object, col: node.parts[0] };
  if (matches.length === 0) throw fail(`Unknown field '${node.parts[0]}' in JOIN condition.`);
  throw fail(`Qualify '${node.parts[0]}' with a table alias in the JOIN condition.`);
}

function hopMatches(hop, on) {
  const ends = hop.dir === 'up'
    ? [
        { object: hop.from, field: hop.field },
        { object: hop.to, field: 'Id' },
      ]
    : [
        { object: hop.to, field: hop.field },
        { object: hop.from, field: 'Id' },
      ];
  const matches = (side, end) => side.object === end.object && side.col.toLowerCase() === end.field.toLowerCase();
  return (
    (matches(on.a, ends[0]) && matches(on.b, ends[1])) ||
    (matches(on.a, ends[1]) && matches(on.b, ends[0]))
  );
}

function findPath(schema, from, to) {
  const seen = new Set([from]);
  const queue = [{ node: from, hops: [] }];
  while (queue.length) {
    const current = queue.shift();
    if (current.node === to) return current.hops;
    for (const hop of neighbors(schema, current.node)) {
      if (seen.has(hop.to)) continue;
      if (!schema.objects[hop.to]) continue;
      seen.add(hop.to);
      queue.push({ node: hop.to, hops: [...current.hops, hop] });
    }
  }
  return null;
}

function neighbors(schema, name) {
  const obj = schema.objects[name];
  const out = [];
  for (const lookup of obj.lookups || []) {
    if (!lookup.relationship) continue;
    out.push({ dir: 'up', field: lookup.field, rel: lookup.relationship, from: name, to: lookup.target });
  }
  for (const child of obj.children || []) {
    if (!child.relationship) continue;
    out.push({ dir: 'down', field: child.field, rel: child.relationship, from: name, to: child.object });
  }
  return out;
}

function buildFields(ast, builder) {
  const fields = [];
  const buckets = new Map();
  const emitted = new Set();
  const flushDown = (rel) => {
    if (emitted.has(rel)) return;
    emitted.add(rel);
    fields.push({ type: 'FieldSubquery', subquery: { fields: buckets.get(rel), relationshipName: rel } });
  };
  for (const item of ast.select) {
    if (item.kind === 'star') {
      const target = item.table ? resolveTableRef(builder, item.table) : null;
      const object = target ? target.object : builder.base.object;
      const placement = builder.placed.get(object);
      builder.warnings.add(
        target
          ? `SELECT ${target.entry.alias}.* expanded to the cached fields of ${object}.`
          : `SELECT * expanded to the cached fields of ${object}.`
      );
      for (const field of Object.keys(builder.schema.objects[object].fields)) {
        addResolvedCol(builder, placement, object, field, null, fields, buckets, flushDown);
      }
      continue;
    }
    resolveSelectExpr(builder, item, fields, buckets, flushDown);
  }
  for (const rel of buckets.keys()) flushDown(rel);
  return fields;
}

function resolveTableRef(builder, aliasName) {
  const entry = builder.tables.get(aliasName.toLowerCase());
  if (!entry) {
    const available = [...builder.tables.values()].map((t) => t.alias).join(', ');
    throw fail(`Unknown alias '${aliasName}'. Available: ${available}.`);
  }
  return { object: entry.object, placement: builder.placed.get(entry.object), entry };
}

function resolveColRef(builder, parts) {
  if (parts.length === 1) {
    assertField(builder.schema, builder.base.object, parts[0]);
    return { placement: builder.placed.get(builder.base.object), object: builder.base.object, field: parts[0] };
  }
  const entry = builder.tables.get(parts[0].toLowerCase());
  if (!entry) {
    const available = [...builder.tables.values()].map((t) => t.alias).join(', ');
    throw fail(`Unknown alias '${parts[0]}'. Available: ${available}.`);
  }
  assertField(builder.schema, entry.object, parts[1]);
  return { placement: builder.placed.get(entry.object), object: entry.object, field: parts[1] };
}

function dottedOf(ref) {
  if (ref.placement.kind === 'up') return [...ref.placement.dot, ref.field].join('.');
  return ref.field;
}

function addResolvedCol(builder, placement, object, field, alias, fields, buckets, flushDown) {
  if (placement.kind === 'down') {
    if (!buckets.has(placement.childRel)) buckets.set(placement.childRel, []);
    const node = { type: 'Field', field };
    if (alias) node.alias = alias;
    buckets.get(placement.childRel).push(node);
    flushDown(placement.childRel);
    return;
  }
  if (placement.kind === 'up') {
    const node = { type: 'FieldRelationship', field, relationships: [...placement.dot] };
    if (alias) node.alias = alias;
    fields.push(node);
    return;
  }
  const node = { type: 'Field', field };
  if (alias) node.alias = alias;
  fields.push(node);
}

function resolveSelectExpr(builder, item, fields, buckets, flushDown) {
  const { expr, alias } = item;
  if (expr.kind === 'col') {
    const ref = resolveColRef(builder, expr.parts);
    addResolvedCol(builder, ref.placement, ref.object, ref.field, alias, fields, buckets, flushDown);
    if (alias) builder.aliasMap.set(alias.toLowerCase(), { ref, fn: null });
    return;
  }
  if (expr.kind === 'call' || expr.kind === 'extract') {
    const fn = convertFn(builder, expr);
    const node = { type: 'FieldFunctionExpression', functionName: fn.name, parameters: fn.params };
    if (alias) node.alias = alias;
    fields.push(node);
    if (alias) builder.aliasMap.set(alias.toLowerCase(), { ref: null, fn: node });
    return;
  }
  throw fail('That SELECT expression cannot be expressed in SOQL.');
}

function convertFn(builder, expr) {
  if (expr.kind === 'extract') {
    const map = { MONTH: 'CALENDAR_MONTH', YEAR: 'CALENDAR_YEAR', DAY: 'CALENDAR_DAY' };
    const name = map[expr.part];
    if (!name) throw fail(`EXTRACT(${expr.part} ...) cannot be expressed in SOQL.`);
    const col = requireFnCol(builder, expr.col);
    builder.warnings.add(`EXTRACT(${expr.part} FROM ${col}) converted back to ${name}.`);
    return { name, params: [col] };
  }
  if (!['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(expr.name)) {
    throw fail(`Function ${expr.name} cannot be expressed in SOQL.`);
  }
  const params = [];
  for (const arg of expr.args) {
    if (arg.kind === 'star') {
      if (expr.name !== 'COUNT') throw fail(`* inside ${expr.name} cannot be expressed in SOQL.`);
      continue;
    }
    params.push(requireFnCol(builder, arg));
  }
  return { name: expr.name, params };
}

function requireFnCol(builder, node) {
  if (!node || node.kind !== 'col') throw fail('That function argument cannot be expressed in SOQL.');
  const ref = resolveColRef(builder, node.parts);
  if (ref.placement.kind === 'down') {
    throw fail(`Aggregate over child object '${ref.object}' cannot be expressed in SOQL. Query the child separately.`);
  }
  return dottedOf(ref);
}

function chainize(node) {
  const flat = linearize(node);
  if (!flat.leaves.length) return { left: node };
  let chained = { left: flat.leaves[flat.leaves.length - 1] };
  for (let i = flat.leaves.length - 2; i >= 0; i -= 1) {
    chained = { left: flat.leaves[i], operator: flat.ops[i], right: chained };
  }
  return chained;
}

function linearize(node) {
  if (!node || typeof node !== 'object') return { leaves: [], ops: [] };
  if (node.left && node.right && !('field' in node) && !('fn' in node)) {
    const left = linearize(node.left);
    const right = linearize(node.right);
    return { leaves: [...left.leaves, ...right.leaves], ops: [...left.ops, node.operator, ...right.ops] };
  }
  return { leaves: [node], ops: [] };
}

function convertCond(node, builder, clause) {
  if (node.kind === 'logic') {
    return {
      left: convertCond(node.left, builder, clause),
      operator: node.op,
      right: convertCond(node.right, builder, clause),
    };
  }
  if (node.kind === 'group') {
    const inner = convertCond(node.expr, builder, clause);
    addParens(inner);
    return inner;
  }
  if (node.kind === 'isnull') {
    const col = requireFilterCol(builder, node.target, clause);
    return { field: col, operator: node.neg ? '!=' : '=', value: 'NULL', literalType: 'NULL' };
  }
  if (node.kind === 'in') {
    const col = requireFilterCol(builder, node.target, clause);
    const values = node.items.map((item) => {
      if (!item || item.kind !== 'literal') throw fail('IN needs literal values.');
      return item;
    });
    return {
      field: col,
      operator: node.neg ? 'NOT IN' : 'IN',
      value: values.map((v) => v.value),
      literalType: values[0].literalType,
    };
  }
  if (node.kind === 'compare') return convertCompare(node, builder, clause);
  throw fail(`That ${clause} expression cannot be expressed in SOQL.`);
}

function addParens(node) {
  let left = node;
  while (left.left) left = left.left;
  left.openParen = (left.openParen || 0) + 1;
  let right = node;
  while (right.right) right = right.right;
  right.closeParen = (right.closeParen || 0) + 1;
}

function requireFilterCol(builder, node, clause) {
  if (!node || node.kind !== 'col') throw fail(`That ${clause} expression cannot be expressed in SOQL.`);
  const ref = resolveColRef(builder, node.parts);
  if (ref.placement.kind === 'down') {
    if (clause === 'WHERE') {
      throw fail(`Filter on child object '${ref.object}' needs a semi join this version cannot build yet.`);
    }
    throw fail(`Filter on child object '${ref.object}' cannot be expressed in SOQL.`);
  }
  return dottedOf(ref);
}

function convertCompare(node, builder, clause) {
  if (node.left.kind === 'call' || node.left.kind === 'extract') {
    const fn = convertFn(builder, node.left);
    if (!node.right || node.right.kind !== 'literal') {
      throw fail(`That ${clause} expression cannot be expressed in SOQL.`);
    }
    return {
      fn: { functionName: fn.name, parameters: fn.params, rawValue: `${fn.name}(${fn.params.join(', ')})` },
      operator: mapOp(node.op),
      value: node.right.value,
      literalType: node.right.literalType,
    };
  }
  const col = requireFilterCol(builder, node.left, clause);
  const dateHit = matchDateMath(node.right);
  if (dateHit) {
    if (node.op !== '=' && node.op !== '>=') {
      throw fail(`Cannot convert date math on ${col} back to a SOQL date literal.`);
    }
    builder.warnings.add(`${dateHit.label} converted back to ${dateHit.literal}.`);
    const leaf = { field: col, operator: '=', value: dateHit.literal, literalType: dateHit.literalType };
    if (dateHit.count != null) leaf.dateLiteralVariable = dateHit.count;
    return leaf;
  }
  if (!node.right || node.right.kind !== 'literal') {
    if (containsDate(node.right)) {
      throw fail(`Cannot convert date math on ${col} back to a SOQL date literal.`);
    }
    if (node.right && node.right.kind === 'col') throw fail('Comparing two fields cannot be expressed in SOQL.');
    throw fail(`That ${clause} expression cannot be expressed in SOQL.`);
  }
  return { field: col, operator: mapOp(node.op), value: node.right.value, literalType: node.right.literalType };
}

function mapOp(op) {
  if (op === '!=') return '<>';
  return op;
}

function stripQuotes(raw) {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function matchDateMath(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'currentDate') return { label: 'CURRENT_DATE', literal: 'TODAY', literalType: 'DATE_LITERAL' };
  if (node.kind === 'call' && node.name === 'DATE' && node.args.length === 1 && node.args[0].kind === 'literal') {
    if (stripQuotes(node.args[0].value).toLowerCase() === 'now') {
      return { label: `date('now')`, literal: 'TODAY', literalType: 'DATE_LITERAL' };
    }
    return null;
  }
  if (node.kind === 'call' && node.name === 'DATE' && node.args.length === 2) {
    const [first, second] = node.args;
    if (first.kind === 'literal' && stripQuotes(first.value).toLowerCase() === 'now' && second.kind === 'literal') {
      const span = /^-\s*(\d+)\s+days?$/i.exec(stripQuotes(second.value));
      if (span) {
        return {
          label: `date('now', '${stripQuotes(second.value)}')`,
          literal: `LAST_N_DAYS:${span[1]}`,
          literalType: 'DATE_N_LITERAL',
          count: Number(span[1]),
        };
      }
    }
    return null;
  }
  if (node.kind === 'binary' && node.op === '-' && node.left.kind === 'currentDate' && node.right.kind === 'interval') {
    const span = /^(\d+)\s+days?$/i.exec(stripQuotes(node.right.value));
    if (span) {
      return {
        label: `CURRENT_DATE - INTERVAL '${stripQuotes(node.right.value)}'`,
        literal: `LAST_N_DAYS:${span[1]}`,
        literalType: 'DATE_N_LITERAL',
        count: Number(span[1]),
      };
    }
  }
  return null;
}

function containsDate(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.kind === 'currentDate' || node.kind === 'interval') return true;
  if (node.kind === 'call' && node.name === 'DATE') return true;
  return containsDate(node.left) || containsDate(node.right) || (node.args || []).some(containsDate);
}

function convertGroupItem(node, builder) {
  const resolved = resolveGroupOperand(node, builder, 'GROUP BY');
  if (resolved.fn) return { fn: resolved.fn };
  return { field: resolved.dotted };
}

function convertOrderItem(node, builder) {
  const out = {};
  const resolved = resolveGroupOperand(node.value, builder, 'ORDER BY');
  if (resolved.fn) throw fail('Ordering by an expression cannot be expressed by this version yet.');
  out.field = resolved.dotted;
  if (node.dir === 'DESC') out.order = 'DESC';
  if (node.nulls) out.nulls = node.nulls;
  return out;
}

function resolveGroupOperand(node, builder, clause) {
  if (!node) throw fail(`That ${clause} expression cannot be expressed in SOQL.`);
  if (node.kind === 'literal' && node.literalType === 'INTEGER') {
    const index = Number(node.value) - 1;
    const item = builder.ast.select[index];
    if (!item || item.kind !== 'expr' || !item.expr || item.expr.kind !== 'col') {
      throw fail(`${clause} position ${node.value} does not point at a plain column.`);
    }
    const ref = resolveColRef(builder, item.expr.parts);
    if (ref.placement.kind === 'down') throw fail(`${clause} on a child object cannot be expressed in SOQL.`);
    return { dotted: dottedOf(ref) };
  }
  if (node.kind === 'col' && node.parts.length === 1) {
    const aliased = builder.aliasMap.get(node.parts[0].toLowerCase());
    if (aliased) {
      if (aliased.fn) throw fail(`${clause} by an aggregate alias cannot be expressed in SOQL.`);
      if (aliased.ref.placement.kind === 'down') throw fail(`${clause} on a child object cannot be expressed in SOQL.`);
      return { dotted: dottedOf(aliased.ref) };
    }
  }
  if (node.kind === 'call' || node.kind === 'extract') {
    const fn = convertFn(builder, node);
    return { fn: { functionName: fn.name, parameters: fn.params } };
  }
  if (node.kind !== 'col') throw fail(`That ${clause} expression cannot be expressed in SOQL.`);
  const ref = resolveColRef(builder, node.parts);
  if (ref.placement.kind === 'down') throw fail(`${clause} on a child object cannot be expressed in SOQL.`);
  return { dotted: dottedOf(ref) };
}

function toCount(raw, what) {
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0) throw fail(`${what} needs a whole number.`);
  return count;
}

function suggestName(input, candidates) {
  let best = null;
  let bestDist = Infinity;
  const low = input.toLowerCase();
  for (const candidate of candidates) {
    const dist = levenshtein(low, candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= 3 ? ` Did you mean '${best}'?` : '';
}

function levenshtein(a, b) {
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j += 1) {
      rows[i].push(0);
    }
  }
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}
