import {
  type ContentRequest,
  generationResultSchema,
  type RecordingProposal,
} from '../src/content/schemas.ts';

export const qualityIds = [
  'schema-valid',
  'count-matches',
  'ukrainian-script',
  'literal-target-letter',
  'assigned-sound-in-request',
  'covers-requested-sounds',
  'no-application-ids',
] as const;

export type QualityId = (typeof qualityIds)[number];
export type QualityFinding = { id: QualityId; passed: boolean };

const cyrillic = /\p{Script=Cyrillic}/u;

export function assessGeneration(request: ContentRequest, result: unknown): QualityFinding[] {
  const parsed = generationResultSchema.safeParse(result);
  if (!parsed.success) {
    return qualityIds.map((id) => ({ id, passed: false }));
  }
  const proposals = parsed.data.proposals;
  return [
    { id: 'schema-valid', passed: true },
    { id: 'count-matches', passed: proposals.length === request.exerciseCount },
    { id: 'ukrainian-script', passed: proposals.every(hasCyrillic) },
    { id: 'literal-target-letter', passed: proposals.every(hasTargetLetter) },
    {
      id: 'assigned-sound-in-request',
      passed: proposals.every((p) => request.targetSounds.includes(p.targetSound)),
    },
    {
      id: 'covers-requested-sounds',
      passed: request.targetSounds.every((sound) => proposals.some((p) => p.targetSound === sound)),
    },
    { id: 'no-application-ids', passed: proposals.every(hasAppLocalId) },
  ];
}

function hasCyrillic(proposal: RecordingProposal) {
  return cyrillic.test(proposal.title) && cyrillic.test(proposal.phrase);
}

function hasTargetLetter(proposal: RecordingProposal) {
  return proposal.phrase.toLocaleLowerCase('uk').includes(proposal.targetSound);
}

function hasAppLocalId(proposal: RecordingProposal) {
  return /^proposal-\d+$/.test(proposal.localId);
}
