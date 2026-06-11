/** Deterministic permission engine (#261) — public surface. */
export { resolveGrant, type GrantDecision } from './engine.js';
export {
  matchShellSpecifier,
  matchPathSpecifier,
  matchDomainSpecifier,
  matchMCPSpecifier,
  stableArgsString,
} from './matchers.js';
export { parseShellCommand, type ParsedShell } from './shell-ast.js';
export { breadthOptionsFor, type BreadthOption } from './breadth.js';
