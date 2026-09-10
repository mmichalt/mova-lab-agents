import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ContentRequest,
  checkResultSchema,
  contentRequestSchema,
  type GeneratedProposal,
  type Vocabulary,
} from '../src/content/schemas.ts';
import {
  hasUsableTokens,
  LETTER_PRESENCE_ISSUE,
  normalizePhrase,
  phraseTokens,
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

const mixedTwo = [p('Риба пливе в річці', 'р'), p('Лис біжить до лісу', 'л')];
const mixedSix = [
  p('риба пливе', 'р'),
  p('риба їсть', 'р'),
  p('риба спить', 'р'),
  p('лис біжить', 'л'),
  p('лис сидить', 'л'),
  p('лис їсть', 'л'),
];

test('normalizePhrase applies NFC, Ukrainian case, whitespace, and apostrophes', () => {
  assert.equal(normalizePhrase('  РИБА\u00A0пливе  '), 'риба пливе');
  assert.equal(normalizePhrase('и\u0306'), normalizePhrase('й'));
  assert.equal(normalizePhrase('п\u2019ять'), "п'ять");
  assert.equal(normalizePhrase('ри\u00ADба'), 'риба');
});

test('phraseTokens keep lettered words and drop punctuation-only tokens', () => {
  assert.deepEqual(phraseTokens("п'ять риб"), ["п'ять", 'риб']);
  assert.deepEqual(phraseTokens('будь-який лис'), ['будь-який', 'лис']);
  assert.deepEqual(phraseTokens('---'), []);
  assert.deepEqual(phraseTokens("'''"), []);
  assert.deepEqual(phraseTokens('!!!'), []);
  assert.equal(hasUsableTokens('риба'), true);
  assert.equal(hasUsableTokens('---'), false);
  assert.equal(hasUsableTokens("'''"), false);
});

test('valid single-sound and mixed-sound candidates pass with the letter caveat', () => {
  const single = validateCandidate(req({ targetSounds: ['р'], exerciseCount: 3 }), vocabulary, [
    p('риба пливе', 'р'),
    p('риба їсть', 'р'),
    p('риба спить', 'р'),
  ]);
  assert.deepEqual(single, { status: 'passed', name: 'content', issues: [LETTER_PRESENCE_ISSUE] });

  const mixed = validateCandidate(req({ exerciseCount: 6 }), vocabulary, mixedSix);
  assert.deepEqual(mixed, { status: 'passed', name: 'content', issues: [LETTER_PRESENCE_ISSUE] });

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
    p('лис,пливе', 'л'),
  ]);
  assert.equal(punctuated.status, 'passed');

  const multiWord = validateCandidate(
    req({ targetSounds: ['р'] }),
    { items: [{ word: 'морська риба', targetSound: 'р' }] },
    [p('морська риба пливе', 'р'), p('морська риба спить', 'р')],
  );
  assert.equal(multiWord.status, 'passed');
  assert.equal(checkResultSchema.parse(multiWord).name, 'content');
});

const invalidCases: Array<{
  name: string;
  request?: ContentRequest;
  proposals: GeneratedProposal[];
  codes: string[];
  paths: string[];
}> = [
  {
    name: 'wrong count',
    request: req({ exerciseCount: 6 }),
    proposals: mixedTwo,
    codes: ['WRONG_COUNT'],
    paths: ['proposals'],
  },
  {
    name: 'more proposals than requested',
    request: req({ targetSounds: ['р'], exerciseCount: 1 }),
    proposals: [p('риба пливе', 'р'), p('риба їсть', 'р')],
    codes: ['WRONG_COUNT'],
    paths: ['proposals'],
  },
  {
    name: 'mixed case and spacing duplicates',
    proposals: [p('  РИБА   пливе  ', 'р'), p('риба пливе', 'р')],
    codes: ['DUPLICATE_PHRASE', 'SOUND_DISTRIBUTION'],
    paths: ['proposals[1].phrase', 'proposals'],
  },
  {
    name: 'trailing punctuation duplicates',
    request: req({ targetSounds: ['р'] }),
    proposals: [p('риба пливе.', 'р'), p('риба пливе', 'р')],
    codes: ['DUPLICATE_PHRASE'],
    paths: ['proposals[1].phrase'],
  },
  {
    name: 'Unicode NFC duplicates',
    request: req({ targetSounds: ['л'] }),
    proposals: [p('й лис', 'л'), p('и\u0306 лис', 'л')],
    codes: ['DUPLICATE_PHRASE'],
    paths: ['proposals[1].phrase'],
  },
  {
    name: 'NBSP and collapsed spacing duplicates',
    request: req({ targetSounds: ['р'] }),
    proposals: [p('риба\u00A0пливе', 'р'), p('риба  пливе', 'р')],
    codes: ['DUPLICATE_PHRASE'],
    paths: ['proposals[1].phrase'],
  },
  {
    name: 'missing vocabulary',
    proposals: [p('рак сидить', 'р'), p('лук лежить', 'л')],
    codes: ['MISSING_VOCABULARY', 'MISSING_VOCABULARY'],
    paths: ['proposals[0].phrase', 'proposals[1].phrase'],
  },
  {
    name: 'vocabulary is a token, not a substring',
    request: req({ targetSounds: ['л'] }),
    proposals: [p('лисиця біжить', 'л'), p('ліс шумить', 'л')],
    codes: ['MISSING_VOCABULARY', 'MISSING_VOCABULARY'],
    paths: ['proposals[0].phrase', 'proposals[1].phrase'],
  },
  {
    name: 'missing assigned target letter',
    proposals: [p('риба сидить', 'л'), p('лис біжить', 'р')],
    codes: ['MISSING_TARGET_LETTER', 'MISSING_TARGET_LETTER'],
    paths: ['proposals[0].phrase', 'proposals[1].phrase'],
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
    paths: ['proposals'],
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
    paths: ['proposals'],
  },
  {
    name: 'unrequested sound on a single-sound request',
    request: req({ targetSounds: ['р'] }),
    proposals: [p('риба пливе', 'р'), p('лис біжить', 'л')],
    codes: ['UNREQUESTED_SOUND', 'SOUND_DISTRIBUTION'],
    paths: ['proposals[1].targetSound', 'proposals'],
  },
];

for (const item of invalidCases) {
  test(`candidate reports ${item.name}`, () => {
    const result = validateCandidate(item.request ?? req(), vocabulary, item.proposals);
    const errors = result.issues.filter((entry) => entry.severity === 'error');
    assert.equal(result.status, 'failed');
    assert.equal(result.name, 'content');
    assert.deepEqual(
      errors.map((entry) => entry.code),
      item.codes,
    );
    assert.deepEqual(
      errors.map((entry) => entry.path),
      item.paths,
    );
    assert.equal(result.issues.at(-1)?.code, 'LETTER_PRESENCE_ONLY');
    assert.equal(checkResultSchema.parse(result).status, 'failed');
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

test('apostrophe variants match selected vocabulary', () => {
  const items: Vocabulary = { items: [{ word: "п'ять", targetSound: 'л' }] };
  const result = validateCandidate(req({ targetSounds: ['л'] }), items, [
    p("п'ять лис", 'л'),
    p('п\u2019ять лис біжить', 'л'),
  ]);
  assert.equal(result.status, 'passed');
});
