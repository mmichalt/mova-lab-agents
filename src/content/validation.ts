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
    .replace(/[\u2019\u02BC\u02B9]/gu, "'")
    .replace(/\p{Cf}+/gu, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim()
    .toLocaleLowerCase('uk')
    .normalize('NFC');
}

export function validateCandidate(
  request: ContentRequest,
  vocabulary: Vocabulary,
  proposals: readonly GeneratedProposal[],
): ContentCheck {
  const issues: ValidationIssue[] = [];
  const countOk = proposals.length === request.exerciseCount;
  if (!countOk) {
    issues.push(issue('WRONG_COUNT', 'proposals', 'Expected the requested number of proposals.'));
  }

  const assigned = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  const vocab = vocabulary.items.map((item) => phraseTokens(item.word));

  for (const [index, proposal] of proposals.entries()) {
    const path = `proposals[${index}]`;
    if (!request.targetSounds.includes(proposal.targetSound)) {
      issues.push(
        issue('UNREQUESTED_SOUND', `${path}.targetSound`, 'Sound is not in the request.'),
      );
    }
    assigned.set(proposal.targetSound, (assigned.get(proposal.targetSound) ?? 0) + 1);

    const key = phraseTokens(proposal.phrase).join(' ');
    const duplicateOf = firstIndex.get(key);
    if (duplicateOf !== undefined) {
      issues.push(
        issue(
          'DUPLICATE_PHRASE',
          `${path}.phrase`,
          `Duplicate of proposals[${duplicateOf}].phrase.`,
        ),
      );
    } else {
      firstIndex.set(key, index);
    }

    if (!normalizePhrase(proposal.phrase).includes(proposal.targetSound)) {
      issues.push(
        issue('MISSING_TARGET_LETTER', `${path}.phrase`, 'Assigned target letter is not present.'),
      );
    }
    if (!containsVocab(phraseTokens(proposal.phrase), vocab)) {
      issues.push(
        issue('MISSING_VOCABULARY', `${path}.phrase`, 'Phrase does not use selected vocabulary.'),
      );
    }
  }

  if (countOk) {
    const expected = expectedCounts(request.targetSounds, request.exerciseCount);
    if (![...expected].every(([sound, count]) => (assigned.get(sound) ?? 0) === count)) {
      issues.push(
        issue(
          'SOUND_DISTRIBUTION',
          'proposals',
          'Assigned sounds are not evenly distributed in request order.',
        ),
      );
    }
  }

  const all = [...issues, { ...LETTER_PRESENCE_ISSUE }];
  return issues.length > 0
    ? { status: 'failed', name: 'content', issues: all }
    : { status: 'passed', name: 'content', issues: all };
}

function expectedCounts(sounds: readonly string[], total: number) {
  const base = Math.floor(total / sounds.length);
  const remainder = total % sounds.length;
  return new Map(sounds.map((sound, index) => [sound, base + (index < remainder ? 1 : 0)]));
}

export function phraseTokens(value: string) {
  return normalizePhrase(value)
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => /\p{L}|\p{N}/u.test(token));
}

export function hasUsableTokens(value: string) {
  return phraseTokens(value).length > 0;
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

function issue(code: string, path: string, message: string): ValidationIssue {
  return { source: 'content', code, path, severity: 'error', message };
}
