import type { GrammarPoint } from '@jle/engine';
import aruIru from '../points/aru-iru.json' with { type: 'json' };
import deLocation from '../points/de-location.json' with { type: 'json' };
import eDirection from '../points/e-direction.json' with { type: 'json' };
import gaSubject from '../points/ga-subject.json' with { type: 'json' };
import iAdjective from '../points/i-adjective.json' with { type: 'json' };
import karaMade from '../points/kara-made.json' with { type: 'json' };
import moAlso from '../points/mo-also.json' with { type: 'json' };
import naAdjective from '../points/na-adjective.json' with { type: 'json' };
import niLocation from '../points/ni-location.json' with { type: 'json' };
import noPossessive from '../points/no-possessive.json' with { type: 'json' };
import taiWant from '../points/tai-want.json' with { type: 'json' };
import teForm from '../points/te-form.json' with { type: 'json' };
import teIru from '../points/te-iru.json' with { type: 'json' };
import toYaAnd from '../points/to-ya-and.json' with { type: 'json' };
import waTopic from '../points/wa-topic.json' with { type: 'json' };
import woObject from '../points/wo-object.json' with { type: 'json' };
import { validatePoint } from './schema';

/**
 * Every grammar point, drafts included. The engine's catalog keeps only approved ones (a named reviewer and a date),
 * so a draft never reaches the learner. Each file in points/ must be listed here; a test checks that.
 */
export const POINT_FILES = [
  aruIru,
  deLocation,
  eDirection,
  gaSubject,
  iAdjective,
  karaMade,
  moAlso,
  naAdjective,
  niLocation,
  noPossessive,
  taiWant,
  teForm,
  teIru,
  toYaAnd,
  waTopic,
  woObject,
] as unknown[];

export const GRAMMAR: GrammarPoint[] = POINT_FILES.map((p) => {
  const errors = validatePoint(p);
  if (errors.length) throw new Error(`Invalid grammar point ${(p as { id?: string }).id}: ${errors.join('; ')}`);
  return p as GrammarPoint;
});

export { validatePoint } from './schema';
