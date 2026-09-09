import type {
  CheckResult,
  ContentRequest,
  GeneratedProposal,
  ValidationIssue,
  Vocabulary,
} from './schemas.ts';

export type ContentCheck = Extract<CheckResult, { status: 'passed' | 'failed' }>;

export const LETTER_PRESENCE_ISSUE: ValidationIssue = Object.freeze({
  source: 'content',
  code: 'LETTER_PRESENCE_ONLY',
  severity: 'warning',
  message: 'Cyrillic letter presence is not phonetic, hard/soft, or therapeutic validation.',
});

export function normalizePhrase(value: string) {
  return value
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim()
    .toLocaleLowerCase('uk');
}

export function validateCandidate(
  request: ContentRequest,
  vocabulary: Vocabulary,
  proposals: readonly GeneratedProposal[],
): ContentCheck {
  const issues: ValidationIssue[] = [];
  if (proposals.length !== request.exerciseCount) {
    issues.push(error('WRONG_COUNT', 'proposals', 'Expected the requested number of proposals.'));
  }

  const assigned = new Map<string, number>();
  const seen = new Set<string>();
  const vocab = vocabulary.items.map((item) => tokens(item.word));

  for (const [index, proposal] of proposals.entries()) {
    const path = `proposals[${index}]`;
    if (!request.targetSounds.includes(proposal.targetSound)) {
      issues.push(
        error('UNREQUESTED_SOUND', `${path}.targetSound`, 'Sound is not in the request.'),
      );
    }
    assigned.set(proposal.targetSound, (assigned.get(proposal.targetSound) ?? 0) + 1);

    const normalized = normalizePhrase(proposal.phrase);
    if (seen.has(normalized)) {
      issues.push(
        error('DUPLICATE_PHRASE', `${path}.phrase`, 'Phrase duplicates an earlier exercise.'),
      );
    } else {
      seen.add(normalized);
    }

    if (!normalized.includes(proposal.targetSound)) {
      issues.push(
        error('MISSING_TARGET_LETTER', `${path}.phrase`, 'Assigned target letter is not present.'),
      );
    }
    if (!containsVocab(tokens(proposal.phrase), vocab)) {
      issues.push(
        error('MISSING_VOCABULARY', `${path}.phrase`, 'Phrase does not use selected vocabulary.'),
      );
    }
  }

  const expected = expectedCounts(request.targetSounds, request.exerciseCount);
  if (![...expected].every(([sound, count]) => (assigned.get(sound) ?? 0) === count)) {
    issues.push(
      error(
        'SOUND_DISTRIBUTION',
        'proposals',
        'Assigned sounds are not evenly distributed in request order.',
      ),
    );
  }

  const all = [...issues, LETTER_PRESENCE_ISSUE];
  return issues.length > 0 ? { status: 'failed', issues: all } : { status: 'passed', issues: all };
}

function expectedCounts(sounds: readonly string[], total: number) {
  const base = Math.floor(total / sounds.length);
  const remainder = total % sounds.length;
  return new Map(sounds.map((sound, index) => [sound, base + (index < remainder ? 1 : 0)]));
}

function tokens(value: string) {
  return normalizePhrase(value)
    .split(' ')
    .map((token) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))
    .filter(Boolean);
}

function containsVocab(phrase: string[], words: string[][]) {
  return words.some((word) => {
    if (word.length === 0 || word.length > phrase.length) return false;
    for (let i = 0; i <= phrase.length - word.length; i++) {
      if (word.every((token, offset) => phrase[i + offset] === token)) return true;
    }
    return false;
  });
}

function error(code: string, path: string, message: string): ValidationIssue {
  return { source: 'content', code, path, severity: 'error', message };
}
