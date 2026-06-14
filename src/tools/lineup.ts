import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import {
  loadLineups,
  saveLineup,
  resolveActiveLineup,
  validateLineupName,
  LINEUP_TIERS,
  type Lineup,
  type LineupTier,
  type RoleSlots,
} from '../lineups.js';
import { ALL_ROLE_IDS, getRole, type RoleId } from '../model-roles.js';
import { savePreferences, type BernardConfig } from '../config.js';
import { BUILTIN_PROVIDERS } from '../providers/types.js';
import { validateLineup, formatLineupValidation } from '../model-validate.js';

/**
 * Agent-facing lineup editor (feature follow-up to #264). Lets Bernard read,
 * update, and create model lineups when the user pastes in `(provider, model)`
 * values — instead of the user having to drive the `/lineup` overlay by hand.
 *
 * A lineup is a 6-role × 3-tier matrix; this tool applies sparse slot
 * assignments onto an existing lineup (or a clone of a base lineup, for
 * `create`), leaving every unspecified slot at its prior value. That keeps the
 * saved lineup fully valid (all 18 slots populated) no matter how little the
 * user pasted.
 *
 * The tool deliberately does NOT decide *which* lineup to touch when the user
 * is vague — it returns the list of options so the agent can ask via
 * `ask_user`. This matches the requested behavior: "if you tell him what
 * lineup to update he'll do it, otherwise he'll ask."
 */

const SlotSchema = z.object({
  role: z
    .enum([...ALL_ROLE_IDS, 'all'] as unknown as [string, ...string[]])
    .describe(
      `Functional role this binding is for. One of: ${ALL_ROLE_IDS.join(', ')}. ` +
        `Use "all" to apply the same (provider, model) to every role at this tier — ` +
        `the common case when the user pastes a single provider's premium/mid/cheap set.`,
    ),
  tier: z
    .enum(LINEUP_TIERS as unknown as [string, ...string[]])
    .describe('Cost tier: premium (strongest), mid, or cheap.'),
  provider: z.string().describe('Provider id, e.g. "openai", "anthropic", "xai", or a custom one.'),
  model: z.string().describe('Model name as the provider expects it, e.g. "gpt-5.5-pro".'),
});

function formatMatrix(l: Lineup): string {
  const lines: string[] = [];
  for (const roleId of ALL_ROLE_IDS) {
    const slots = l.roles[roleId];
    const cell = (t: LineupTier): string => `${slots[t].provider}/${slots[t].model}`;
    lines.push(
      `  ${getRole(roleId).label.padEnd(16)} premium=${cell('premium')}  mid=${cell('mid')}  cheap=${cell('cheap')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Applies sparse slot assignments onto a (cloned) role matrix, mutating it in
 * place. `role: 'all'` fans the binding out across every role at that tier.
 */
function applySlots(
  roles: Record<RoleId, RoleSlots>,
  slots: Array<z.infer<typeof SlotSchema>>,
): void {
  for (const s of slots) {
    const tier = s.tier as LineupTier;
    const binding = { provider: s.provider.trim(), model: s.model.trim() };
    const targets: RoleId[] = s.role === 'all' ? [...ALL_ROLE_IDS] : [s.role as RoleId];
    for (const r of targets) roles[r] = { ...roles[r], [tier]: { ...binding } };
  }
}

/** Returns provider ids referenced by `slots` that Bernard has no key/SDK for. */
function unknownProviders(config: BernardConfig | undefined, slots: Array<{ provider: string }>): string[] {
  const known = new Set<string>([
    ...BUILTIN_PROVIDERS,
    ...Object.keys(config?.customProviders ?? {}),
  ]);
  const seen = new Set<string>();
  for (const s of slots) {
    const p = s.provider.trim();
    if (p && !known.has(p)) seen.add(p);
  }
  return [...seen];
}

export function createLineupTool(config?: BernardConfig) {
  return attachMeta(
    tool({
      description:
        'Read, update, or create model lineups (the role × cost-tier matrix that decides which model each kind of work uses). ' +
        'Use this when the user pastes provider/model values and asks you to set up or change a lineup.\n\n' +
        '- action="list": show every lineup and its current bindings. Call this first if the user did not say WHICH lineup to change — then ask them with the ask_user tool.\n' +
        '- action="update": change slots on an existing lineup (pass its `id`). Unspecified slots keep their current value.\n' +
        '- action="create": make a new lineup (pass `name`). Unspecified slots are copied from `base` (or the active lineup).\n' +
        '- action="validate": live-probe every distinct model in a lineup (pass `id`, or omit for the active lineup) with the real API key and report which are reachable.\n\n' +
        'Provide bindings via `slots`: each entry is {role, tier, provider, model}. Use role="all" to set one tier for every role at once (the usual case). ' +
        'Set activate=true to make the lineup active immediately. Do NOT guess an id — if unsure which lineup the user means, list and ask.\n\n' +
        'After create/update the new bindings are AUTOMATICALLY live-validated (set validate=false to skip). A model can pass validation and still be too weak for real work, so a green check means "reachable", not "good".',
      parameters: z.object({
        action: z.enum(['list', 'update', 'create', 'validate']),
        id: z
          .string()
          .optional()
          .describe(
            'The id of the lineup to act on (see action="list"). Required for action="update"; for action="validate" the lineup to probe (omit to probe the active one). Not used by action="create" — see `base` to clone slots from another lineup.',
          ),
        name: z
          .string()
          .optional()
          .describe(
            'For action="create": display name of the new lineup. For action="update": optional, renames the lineup.',
          ),
        base: z
          .string()
          .optional()
          .describe(
            'For action="create": id of an existing lineup to copy unspecified slots from. Defaults to the active lineup.',
          ),
        slots: z.array(SlotSchema).optional().describe('Slot bindings to apply.'),
        activate: z
          .boolean()
          .optional()
          .describe('When true, switch Bernard to this lineup after saving it.'),
        validate: z
          .boolean()
          .optional()
          .describe(
            'For create/update: live-probe the resulting models to confirm they are reachable (default true). Set false to skip the network calls.',
          ),
      }),
      execute: async ({ action, id, name, base, slots, activate, validate }): Promise<string> => {
        try {
          const lineups = loadLineups();
          const activeId = resolveActiveLineup(
            lineups,
            config?.activeLineupId,
            config?.provider,
          ).id;

          if (action === 'list') {
            const all = Object.values(lineups);
            const blocks = all.map(
              (l) =>
                `${l.id === activeId ? '➤ ' : '  '}${l.name} (id: ${l.id})${
                  l.id === activeId ? '  [active]' : ''
                }\n${formatMatrix(l)}`,
            );
            return (
              `Lineups (${all.length}). Roles: ${ALL_ROLE_IDS.join(', ')}. Tiers: ${LINEUP_TIERS.join('/')}.\n\n` +
              blocks.join('\n\n')
            );
          }

          if (action === 'validate') {
            if (!config) return 'Cannot validate — no live config available.';
            // A supplied-but-unknown id is an error, not a silent fall-through to
            // the active lineup — otherwise the agent gets a report for the wrong
            // lineup and never learns its id was wrong. Omitting id still probes
            // the active one.
            if (id && !lineups[id]) {
              return `No lineup with id "${id}". Available: ${Object.keys(lineups).join(', ')}.`;
            }
            const target = lineups[id ?? activeId];
            if (!target) {
              return `No lineup to validate. Available: ${Object.keys(lineups).join(', ')}.`;
            }
            const v = await validateLineup(config, target);
            return formatLineupValidation(v);
          }

          const applied = slots ?? [];

          const activateIfAsked = (saved: Lineup): string => {
            if (!activate) return '';
            if (!config) return '\n(Could not activate — no live config available; switch with /lineups.)';
            config.activeLineupId = saved.id;
            try {
              savePreferences({
                provider: config.provider,
                model: config.model,
                activeLineupId: saved.id,
              });
              return `\nThis lineup is now active.`;
            } catch (err) {
              return `\n(Saved, but failed to activate: ${(err as Error).message}. Switch with /lineups.)`;
            }
          };

          const warnUnknown = (): string => {
            const unknown = unknownProviders(config, applied);
            return unknown.length > 0
              ? `\n⚠ Provider(s) with no configured API key/SDK: ${unknown.join(', ')}. ` +
                  `The lineup is saved, but calls will fail until you add the provider (/provider).`
              : '';
          };

          // After create/update, live-probe the saved lineup so Bernard can tell
          // the user which pasted models actually work. Default on; opt out with
          // validate=false. Fails open — a probe layer error never blocks the save.
          const validateIfAsked = async (saved: Lineup): Promise<string> => {
            if (validate === false) return '';
            if (!config) return '';
            try {
              const v = await validateLineup(config, saved);
              return `\n\n${formatLineupValidation(v)}` + (v.ok ? '' : '\n(Note: a passing probe means reachable, not necessarily good at the task.)');
            } catch (err) {
              return `\n\n(Could not validate models: ${(err as Error).message})`;
            }
          };

          if (action === 'update') {
            if (!id || !lineups[id]) {
              const ids = Object.keys(lineups);
              return (
                `${id ? `No lineup with id "${id}". ` : 'No lineup id given. '}` +
                `Ask the user which one to update, then retry. Available: ${ids.join(', ')}.`
              );
            }
            if (applied.length === 0 && !name) {
              return 'Nothing to change — pass `slots` to update bindings and/or `name` to rename.';
            }
            const existing = lineups[id];
            const roles = structuredClone(existing.roles);
            applySlots(roles, applied);
            const nextName = name?.trim() || existing.name;
            const nameErr = validateLineupName(nextName);
            if (nameErr) return `Invalid name: ${nameErr}`;
            const saved = saveLineup({ id, name: nextName, roles });
            return (
              `Updated lineup "${saved.name}" (id: ${saved.id}).\n${formatMatrix(saved)}` +
              warnUnknown() +
              activateIfAsked(saved) +
              (await validateIfAsked(saved))
            );
          }

          // action === 'create'
          if (!name || !name.trim()) {
            return 'To create a lineup, pass a `name`. Ask the user for one if they did not provide it.';
          }
          const nameErr = validateLineupName(name);
          if (nameErr) return `Invalid name: ${nameErr}`;
          const baseId = base && lineups[base] ? base : activeId;
          const baseLineup = lineups[baseId];
          const roles = structuredClone(baseLineup.roles);
          applySlots(roles, applied);
          const saved = saveLineup({ name: name.trim(), roles });
          return (
            `Created lineup "${saved.name}" (id: ${saved.id}), based on "${baseLineup.name}".\n${formatMatrix(saved)}` +
            warnUnknown() +
            activateIfAsked(saved) +
            (await validateIfAsked(saved))
          );
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    {
      name: 'lineup_edit',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      // list/validate are read-only; only update/create mutate on-disk lineups.
      isWriteAction: (args: unknown) => {
        const a = (args as { action?: string } | undefined)?.action;
        return a !== 'list' && a !== 'validate';
      },
    },
  );
}
