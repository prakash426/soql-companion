import { parseQuery } from '@jetstreamapp/soql-parser-js';

const DIALECTS = ['postgres', 'sqlite'];
const KNOWN_USER_RELS = { Owner: 'User', CreatedBy: 'User', LastModifiedBy: 'User' };
const AGGREGATES = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];
const ID_SAFE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function soqlToSql(soql, dialect) {
  if (!DIALECTS.includes(dialect)) {
    throw new Error(`Unknown dialect '${dialect}'. Use postgres or sqlite.`);
  }
  let tree;
  try {
    tree = parseQuery(soql);
  } catch (err) {
    throw new Error(`Invalid SOQL: ${(err && err.message) || err}`);
  }
  const ctx = { dialect, warnings: new Set() };
  const statements = emitStatements(tree, ctx);
  return { sql: statements.join(';\n\n') + ';', warnings: [...ctx.warnings] };
}

function newState() {
  return { joins: [], aliasSeq: 0, joinKeys: new Map() };
}

function emitStatements(tree, ctx) {
  const out = [emitSelect(tree, ctx, newState(), false)];
  for (const f of tree.fields || []) {
    if (f && f.type === 'FieldSubquery' && f.subquery) {
      const table = f.subquery.relationshipName || 'UnknownChild';
      ctx.warnings.add(
        `Parent-to-child subquery on ${table} emitted as a separate statement. Add the parent key filter for your mirror.`
      );
      out.push(emitSelect({ ...f.subquery, sObject: table }, ctx, newState(), false));
    }
  }
  return out;
}

function emitSelect(tree, ctx, st, inline) {
  const selectList = [];
  for (const f of tree.fields || []) {
    selectList.push(...emitField(f, tree.sObject, ctx, st));
  }
  if (!selectList.length) selectList.push('*');
  const parts = [`SELECT ${selectList.join(', ')}`, `FROM ${ident(tree.sObject, ctx)}`];
  for (const join of st.joins) parts.push(join);
  if (tree.where) parts.push(`WHERE ${emitCond(tree.where, ctx)}`);
  if (tree.groupBy) parts.push(`GROUP BY ${tree.groupBy.map((g) => emitGroupItem(g, ctx)).join(', ')}`);
  if (tree.having) parts.push(`HAVING ${emitCond(tree.having, ctx)}`);
  if (tree.orderBy) parts.push(`ORDER BY ${tree.orderBy.map((o) => emitOrderItem(o, ctx)).join(', ')}`);
  if (tree.limit != null) parts.push(`LIMIT ${tree.limit}`);
  if (tree.offset != null) parts.push(`OFFSET ${tree.offset}`);
  return inline ? parts.join(' ') : parts.join('\n');
}

function emitField(f, base, ctx, st) {
  if (!f || typeof f !== 'object') return [];
  if (f.type === 'FieldRelationship') {
    const alias = ensureChain(base, f.relationships || [], ctx, st);
    const col = `${alias}.${ident(f.field, ctx)}`;
    return [f.alias ? `${col} AS ${ident(f.alias, ctx)}` : col];
  }
  if (f.type === 'FieldFunctionExpression') {
    return [emitFn(f, ctx) + (f.alias ? ` AS ${ident(f.alias, ctx)}` : '')];
  }
  if (f.type === 'FieldTypeof') {
    ctx.warnings.add('TYPEOF expanded to one column per branch. Point each at the matching mirror column.');
    const cols = [];
    for (const c of f.conditions || []) {
      const tag = c.objectType ? `_${c.objectType}` : '';
      for (const name of c.fieldList || []) cols.push(ident(`${f.field}${tag}_${name}`, ctx));
    }
    return cols.length ? cols : [`NULL AS ${ident(`${f.field}_empty`, ctx)}`];
  }
  if (f.type === 'FieldSubquery') return [];
  const col = ident(f.field, ctx);
  return [f.alias ? `${col} AS ${ident(f.alias, ctx)}` : col];
}

function ensureChain(base, rels, ctx, st) {
  let parent = base;
  let parentAlias = null;
  for (const rel of rels) {
    const key = `${parentAlias || parent}.${rel}`;
    let alias = st.joinKeys.get(key);
    if (!alias) {
      st.aliasSeq += 1;
      alias = `j${st.aliasSeq}`;
      st.joinKeys.set(key, alias);
      const { table, fk, note } = resolveRel(parent, rel);
      const leftRef = parentAlias || ident(parent, ctx);
      st.joins.push(`LEFT JOIN ${ident(table, ctx)} AS ${alias} ON ${leftRef}.${ident(fk, ctx)} = ${alias}.Id`);
      ctx.warnings.add(note);
      parent = table;
    } else {
      parent = resolveRel(parent, rel).table;
    }
    parentAlias = alias;
  }
  return parentAlias;
}

function resolveRel(parent, rel) {
  if (KNOWN_USER_RELS[rel]) {
    return {
      table: 'User',
      fk: `${rel}Id`,
      note: `${rel} resolved to User. Queues and groups need a manual fix.`,
    };
  }
  if (rel.endsWith('__r')) {
    const stem = rel.slice(0, -3);
    return {
      table: `${stem}__c`,
      fk: `${stem}__c`,
      note: `Guessed JOIN: ${parent}.${stem}__c to ${stem}__c.Id. Verify table and key names against your mirror.`,
    };
  }
  return {
    table: rel,
    fk: `${rel}Id`,
    note: `Guessed JOIN: ${parent}.${rel}Id to ${rel}.Id. Verify table and key names against your mirror.`,
  };
}

function emitFn(f, ctx) {
  const name = String(f.functionName || '').toUpperCase();
  const args = (f.parameters || []).map((p) => ident(String(p), ctx)).join(', ');
  if (name === 'COUNT' && args === '') return 'COUNT(*)';
  if (AGGREGATES.includes(name)) return `${name}(${args})`;
  const mapped = mapDateFn(name, f.parameters || [], ctx);
  if (mapped) return mapped;
  ctx.warnings.add(`Function ${name} passed through as written. Verify it exists in ${ctx.dialect}.`);
  return `${name}(${args})`;
}

function mapDateFn(name, params, ctx) {
  const col = ident(String(params[0] || ''), ctx);
  const table = {
    CALENDAR_MONTH: {
      postgres: `EXTRACT(MONTH FROM ${col})`,
      sqlite: `CAST(strftime('%m', ${col}) AS INTEGER)`,
    },
    CALENDAR_YEAR: {
      postgres: `EXTRACT(YEAR FROM ${col})`,
      sqlite: `CAST(strftime('%Y', ${col}) AS INTEGER)`,
    },
    CALENDAR_DAY: {
      postgres: `EXTRACT(DAY FROM ${col})`,
      sqlite: `CAST(strftime('%d', ${col}) AS INTEGER)`,
    },
  }[name];
  if (!table) return null;
  ctx.warnings.add(`Date function ${name} converted to ${ctx.dialect} date math.`);
  return table[ctx.dialect];
}

function emitGroupItem(g, ctx) {
  if (g && g.fn) return emitFn(g.fn, ctx);
  return ident(g && g.field, ctx);
}

function emitOrderItem(o, ctx) {
  let out = o.field ? ident(o.field, ctx) : emitFn(o.fn || {}, ctx);
  if (o.order === 'DESC') out += ' DESC';
  if (o.nulls) {
    out += ` NULLS ${o.nulls}`;
    if (ctx.dialect === 'sqlite') {
      ctx.warnings.add('NULLS ordering kept as written. Verify NULLS ordering on your SQLite version.');
    }
  }
  return out;
}

function emitCond(node, ctx) {
  if (!node || typeof node !== 'object') return '';
  if ('field' in node || 'fn' in node) return emitLeaf(node, ctx);
  const op = String(node.operator || 'AND').toUpperCase();
  const left = emitCond(node.left, ctx);
  const right = node.right === undefined ? '' : emitCond(node.right, ctx);
  if (!right) return left;
  if (!left) return right;
  return `${left} ${op} ${right}`;
}

function emitLeaf(node, ctx) {
  const open = '('.repeat(node.openParen || 0);
  const close = ')'.repeat(node.closeParen || 0);
  const op = String(node.operator || '=').toUpperCase();
  let lhs;
  if (node.fn) {
    lhs = emitLeafFn(node.fn, ctx);
  } else {
    lhs = ident(node.field, ctx);
    if (String(node.field).includes('.')) {
      ctx.warnings.add(`Dotted WHERE field ${node.field} kept as written. Align it with the JOIN aliases.`);
    }
  }
  if (node.valueQuery) {
    return `${open}${lhs} ${op} (${emitSelect(node.valueQuery, ctx, newState(), true)})${close}`;
  }
  if (node.literalType === 'NULL') {
    const isNeg = op === '!=' || op === '<>' || op.startsWith('NOT');
    return `${open}${lhs} ${isNeg ? 'IS NOT NULL' : 'IS NULL'}${close}`;
  }
  if (node.literalType === 'DATE_N_LITERAL' || node.literalType === 'DATE_LITERAL') {
    return `${open}${lhs} ${mapDateOp(op)} ${mapDateValue(node, ctx)}${close}`;
  }
  const rhs = Array.isArray(node.value) ? `(${node.value.join(', ')})` : String(node.value);
  const mappedOp = op === '!=' ? '<>' : op;
  return `${open}${lhs} ${mappedOp} ${rhs}${close}`;
}

function emitLeafFn(fn, ctx) {
  const name = String(fn.functionName || '').toUpperCase();
  if (name === 'FORMULA') {
    try {
      return `(${emitFormulaExpr(fn.formula, ctx)})`;
    } catch {
      ctx.warnings.add('FORMULA kept as written. Rewrite it by hand for SQL.');
      return fn.rawValue || 'FORMULA(?)';
    }
  }
  return emitFn(fn, ctx);
}

function emitFormulaExpr(expr) {
  if (!expr || typeof expr !== 'object') throw new Error('bad formula');
  if (expr.type === 'FieldReference') return (expr.parts || []).join('.');
  if (expr.type === 'BinaryExpression') {
    return `${emitFormulaExpr(expr.left)} ${expr.operator} ${emitFormulaExpr(expr.right)}`;
  }
  if (expr.value != null) return String(expr.value);
  throw new Error('bad formula');
}

function mapDateOp(op) {
  if (op === '=') return '>=';
  if (op === '!=' || op === '<>') return '<';
  return op;
}

function mapDateValue(node, ctx) {
  const raw = String(node.value || '');
  const match = /^LAST_N_DAYS:(\d+)$/.exec(raw);
  const count = node.dateLiteralVariable ?? (match ? match[1] : null);
  if (match && count != null) {
    ctx.warnings.add(`Date literal ${raw} converted to ${ctx.dialect} date math.`);
    return ctx.dialect === 'postgres'
      ? `CURRENT_DATE - INTERVAL '${count} days'`
      : `date('now', '-${count} days')`;
  }
  const fixed = {
    TODAY: { postgres: 'CURRENT_DATE', sqlite: `date('now')` },
    YESTERDAY: { postgres: `CURRENT_DATE - INTERVAL '1 day'`, sqlite: `date('now', '-1 day')` },
    TOMORROW: { postgres: `CURRENT_DATE + INTERVAL '1 day'`, sqlite: `date('now', '+1 day')` },
  }[raw];
  if (fixed) {
    ctx.warnings.add(`Date literal ${raw} converted to ${ctx.dialect} date math.`);
    return fixed[ctx.dialect];
  }
  ctx.warnings.add(`Date literal ${raw} has no ${ctx.dialect} mapping yet. Convert it by hand.`);
  return `'${raw}'`;
}

function ident(name, ctx) {
  const text = String(name);
  if (ID_SAFE.test(text)) return text;
  ctx.warnings.add(`Identifier ${text} quoted. Verify it matches your mirror.`);
  return `"${text.replace(/"/g, '""')}"`;
}
