// Remove proven flag-off template branches before Svelte emits conditional DOM wrappers.
import { parse } from 'svelte/compiler';

const FLAG = 'import.meta.env.VITE_FEATURE_ACCOUNTS';
const simple = node => node && (['Identifier', 'Literal', 'ThisExpression'].includes(node.type)
  || node.type === 'MemberExpression' && simple(node.object) && (!node.computed || simple(node.property))
  || node.type === 'ChainExpression' && simple(node.expression)
  || node.type === 'BinaryExpression' && simple(node.left) && simple(node.right));

/** Only a leading exact flag test and simple AND conjuncts prove this branch removable. */
function falseGate(node, source) {
  if (node?.type === 'BinaryExpression') return node.operator === '==='
    && source.slice(node.left.start, node.left.end) === FLAG
    && node.right.type === 'Literal' && node.right.value === true;
  return node?.type === 'LogicalExpression' && node.operator === '&&'
    && falseGate(node.left, source) && simple(node.right);
}

export function stripAccountBlocks(source, accountsEnabled) {
  if (accountsEnabled || !source.includes(FLAG)) return null;
  // A malformed template must fail the build, never be partially transformed.
  const ast = parse(source, { modern: true });
  const changes = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'IfBlock' && !node.elseif && falseGate(node.test, source)) {
      const alternate = node.alternate?.nodes ?? [];
      // Else-if syntax and direct {@const} declarations require their parent block.
      if (!alternate[0]?.elseif && !alternate.some(child => child.type === 'ConstTag')) {
        const original = alternate.length ? source.slice(alternate[0].start, alternate.at(-1).end) : '';
        changes.push({ start: node.start, end: node.end, replacement: stripAccountBlocks(original, false) ?? original });
        return;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast.fragment);
  if (!changes.length) return null;
  for (const change of changes.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, change.start) + change.replacement + source.slice(change.end);
  }
  return source;
}
