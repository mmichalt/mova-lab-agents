import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ContentRequest,
  contentRequestSchema,
  type GeneratedProposal,
  type Vocabulary,
} from '../src/content/schemas.ts';
import {
  LETTER_PRESENCE_ISSUE,
  normalizePhrase,
  validateCandidate,
} from '../src/content/validation.ts';

const vocabulary: Vocabulary = {
  items: [
    { word: 'риба', targetSound: 'р' },
    { word: 'лис', targetSound: 'л' },
  ],
};

function req(overrides: Partial<ContentRequest> = {}): ContentRequest {
  return {
    ageYears: 7,
    targetSounds: ['р', 'л'],
    difficulty: 'easy',
    theme: 'тварини',
    exerciseCount: 2,
    ...overrides,
  };
}

function p(phrase: string, targetSound: 'р' | 'л'): GeneratedProposal {
  return {
    type: 'recording',
    title: phrase,
    phrase,
    childHint: 'Скажи',
    teacherNote: 'Повільно',
    targetSound,
    difficulty: 'easy',
  };
}

function codes(proposals: GeneratedProposal[], request: ContentRequest = req()) {
  return validateCandidate(request, vocabulary, proposals).issues.map((issue) => issue.code);
}

function errors(proposals: GeneratedProposal[], request: ContentRequest = req()) {
  return validateCandidate(request, vocabulary, proposals)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
}

const mixedTwo = [p('Риба пливе в річці', 'р'), p('Лис біжить до лісу', 'л')];
const mixedSix = [
  p('риба пливе', 'р'),
  p('риба їсть', 'р'),
  p('риба спить', 'р'),
  p('лис біжить', 'л'),
  p('лис сидить', 'л'),
  p('лис їсть', 'л'),
];

test('normalizePhrase applies NFC, Ukrainian case, and Unicode whitespace', () => {
  assert.equal(normalizePhrase('  РИБА\u00A0пливе  '), 'риба пливе');
  assert.equal(normalizePhrase('и\u0306'), normalizePhrase('й'));
});

test('valid single-sound and mixed-sound candidates pass with the letter caveat', () => {
  const single = validateCandidate(req({ targetSounds: ['р'], exerciseCount: 3 }), vocabulary, [
    p('риба пливе', 'р'),
    p('риба їсть', 'р'),
    p('риба спить', 'р'),
  ]);
  assert.deepEqual(single, { status: 'passed', issues: [LETTER_PRESENCE_ISSUE] });

  const mixed = validateCandidate(req({ exerciseCount: 6 }), vocabulary, mixedSix);
  assert.deepEqual(mixed, { status: 'passed', issues: [LETTER_PRESENCE_ISSUE] });

  const remainder = validateCandidate(
    req({ targetSounds: ['л', 'р'], exerciseCount: 5 }),
    vocabulary,
    [
      p('лис біжить', 'л'),
      p('лис сидить', 'л'),
      p('лис їсть', 'л'),
      p('риба пливе', 'р'),
      p('риба їсть', 'р'),
    ],
  );
  assert.equal(remainder.status, 'passed');

  const incidental = validateCandidate(req({ targetSounds: ['р'], exerciseCount: 3 }), vocabulary, [
    p('риба коло лиса', 'р'),
    p('риба їсть', 'р'),
    p('риба спить', 'р'),
  ]);
  assert.equal(incidental.status, 'passed');

  const fromSchema = contentRequestSchema.parse({
    ageYears: 7,
    targetSounds: ['Р', 'л', 'р'],
    difficulty: 'easy',
    theme: 'тварини',
    exerciseCount: 5,
  });
  assert.deepEqual([...fromSchema.targetSounds], ['р', 'л']);
  const parsedOrder = validateCandidate(fromSchema, vocabulary, [
    p('риба пливе', 'р'),
    p('риба їсть', 'р'),
    p('риба спить', 'р'),
    p('лис біжить', 'л'),
    p('лис сидить', 'л'),
  ]);
  assert.equal(parsedOrder.status, 'passed');

  const punctuated = validateCandidate(req({ targetSounds: ['л'] }), vocabulary, [
    p('«Лис» біжить!', 'л'),
    p('лис, спить', 'л'),
  ]);
  assert.equal(punctuated.status, 'passed');
});

const invalidCases: Array<{
  name: string;
  request?: ContentRequest;
  proposals: GeneratedProposal[];
  codes: string[];
}> = [
  {
    name: 'wrong count',
    request: req({ exerciseCount: 6 }),
    proposals: mixedTwo,
    codes: ['WRONG_COUNT', 'SOUND_DISTRIBUTION'],
  },
  {
    name: 'mixed case and spacing duplicates',
    proposals: [p('  РИБА   пливе  ', 'р'), p('риба пливе', 'р')],
    codes: ['DUPLICATE_PHRASE', 'SOUND_DISTRIBUTION'],
  },
  {
    name: 'Unicode NFC duplicates',
    request: req({ targetSounds: ['л'] }),
    proposals: [p('й лис', 'л'), p('и\u0306 лис', 'л')],
    codes: ['DUPLICATE_PHRASE'],
  },
  {
    name: 'NBSP and collapsed spacing duplicates',
    request: req({ targetSounds: ['р'] }),
    proposals: [p('риба\u00A0пливе', 'р'), p('риба  пливе', 'р')],
    codes: ['DUPLICATE_PHRASE'],
  },
  {
    name: 'missing vocabulary',
    proposals: [p('рак сидить', 'р'), p('лук лежить', 'л')],
    codes: ['MISSING_VOCABULARY', 'MISSING_VOCABULARY'],
  },
  {
    name: 'vocabulary is a token, not a substring',
    request: req({ targetSounds: ['л'] }),
    proposals: [p('лисиця біжить', 'л'), p('ліс шумить', 'л')],
    codes: ['MISSING_VOCABULARY', 'MISSING_VOCABULARY'],
  },
  {
    name: 'missing assigned target letter',
    proposals: [p('риба сидить', 'л'), p('лис біжить', 'р')],
    codes: ['MISSING_TARGET_LETTER', 'MISSING_TARGET_LETTER'],
  },
  {
    name: 'incidental other sound does not satisfy assigned coverage',
    request: req({ exerciseCount: 6 }),
    proposals: [
      p('риба і лис', 'р'),
      p('риба коло лиса', 'р'),
      p('риба лис спить', 'р'),
      p('лис і риба', 'р'),
      p('лис риба їсть', 'р'),
      p('лис риба біжить', 'р'),
    ],
    codes: ['SOUND_DISTRIBUTION'],
  },
  {
    name: 'remainder assigned against request order',
    request: req({ targetSounds: ['р', 'л'], exerciseCount: 5 }),
    proposals: [
      p('лис біжить', 'л'),
      p('лис сидить', 'л'),
      p('лис їсть', 'л'),
      p('риба пливе', 'р'),
      p('риба їсть', 'р'),
    ],
    codes: ['SOUND_DISTRIBUTION'],
  },
  {
    name: 'unrequested sound on a single-sound request',
    request: req({ targetSounds: ['р'] }),
    proposals: [p('риба пливе', 'р'), p('лис біжить', 'л')],
    codes: ['UNREQUESTED_SOUND', 'SOUND_DISTRIBUTION'],
  },
];

for (const item of invalidCases) {
  test(`candidate reports ${item.name}`, () => {
    const request = item.request ?? req();
    const result = validateCandidate(request, vocabulary, item.proposals);
    assert.deepEqual(errors(item.proposals, request), item.codes);
    assert.equal(result.status, 'failed');
    assert.equal(result.issues.at(-1)?.code, 'LETTER_PRESENCE_ONLY');
    if (item.name === 'mixed case and spacing duplicates') {
      assert.equal(
        result.issues.find((issue) => issue.code === 'DUPLICATE_PHRASE')?.path,
        'proposals[1].phrase',
      );
    }
  });
}

test('passed candidates never include error-severity issues', () => {
  assert.deepEqual(codes(mixedTwo), ['LETTER_PRESENCE_ONLY']);
  assert.equal(
    validateCandidate(req(), vocabulary, mixedTwo).issues.some(
      (issue) => issue.severity === 'error',
    ),
    false,
  );
});
