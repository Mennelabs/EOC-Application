/**
 * Alias rules (layer-7 task C; CMD-04, BRD:FR-18.05, Section 30.2). A
 * personal alias may only look things up or draft; an organization alias may
 * name a change but never a consequential one (RULE-14), so it cannot conceal
 * what needs a full review. No alias shadows a command verb. The same rules
 * run when an alias is set and again when it is used, because words typed
 * after an alias can change the command it expands to.
 */
import { actions, isActionKey } from '@cg/authz';
import { commandByName, type CommandSpec } from './catalog.ts';
import { parseShorthand, RESERVED_NAMES, type ParseContext } from './parse.ts';

export type AliasScope = 'personal' | 'organization';

export type AliasCheck =
  | { ok: true; command: CommandSpec }
  | { ok: false; code: 'name' | 'reserved' | 'expansion' | 'scope'; message: string };

const NAME = /^[a-z][a-z0-9_-]{1,29}$/;

const consequential = (spec: CommandSpec) =>
  spec.confirmation === 'full_review' ||
  spec.confirmation === 'second_person' ||
  (isActionKey(spec.action) && actions[spec.action].consequential === true);

/** Whether a scope may run this command through an alias. */
export function aliasMayRun(scope: AliasScope, spec: CommandSpec): AliasCheck {
  if (scope === 'personal' && spec.kind === 'change')
    return {
      ok: false,
      code: 'scope',
      message: 'A personal alias can only look things up or draft (Section 30.2).',
    };
  if (consequential(spec))
    return {
      ok: false,
      code: 'scope',
      message: 'An alias cannot stand for an action that needs a full review (CMD-04).',
    };
  return { ok: true, command: spec };
}

export function checkAlias(
  scope: AliasScope,
  name: string,
  expansion: string,
  ctx: ParseContext,
): AliasCheck {
  if (!NAME.test(name))
    return {
      ok: false,
      code: 'name',
      message:
        'Use 2 to 30 lower-case letters, digits, - or _, starting with a letter (for example brief).',
    };
  if (RESERVED_NAMES.has(name))
    return { ok: false, code: 'reserved', message: `"/${name}" is a command; pick another name.` };
  const parsed = parseShorthand(expansion, ctx);
  if (!parsed.ok)
    return {
      ok: false,
      code: 'expansion',
      message: `The expansion is not a command here: ${parsed.message}`,
    };
  return aliasMayRun(scope, commandByName(parsed.command)!);
}
