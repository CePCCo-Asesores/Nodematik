import { describe, it, expect, vi, afterEach } from 'vitest';
import { SafetyClassifier } from '../src/services/safety.service';

describe('SafetyClassifier — keyword rules (sync)', () => {
  const classifier = new SafetyClassifier();

  // ── Must flag ──────────────────────────────────────────────────────────────

  it.each([
    // Spanish — suicide
    ['quiero suicidarme', 'suicide_risk'],
    ['me quiero matar', 'suicide_risk'],
    ['me quiero morir', 'suicide_risk'],
    ['quiero morir', 'suicide_risk'],
    ['quiero morirme', 'suicide_risk'],
    ['quitarme la vida', 'suicide_risk'],
    ['acabar con mi vida', 'suicide_risk'],
    ['no quiero vivir', 'suicide_risk'],
    ['ya no quiero vivir', 'suicide_risk'],
    ['pastillas para suicidarme', 'suicide_risk'],
    ['suicidio', 'suicide_risk'],
    // Spanish — self-harm
    ['quiero lastimarme', 'self_harm'],
    ['quiero hacerme daño', 'self_harm'],
    ['cortarme las venas', 'self_harm'],
    ['me corto', 'self_harm'],
    // English — suicide
    ['I want to kill myself', 'suicide_risk'],
    ['I want to die', 'suicide_risk'],
    ['wanna die', 'suicide_risk'],
    ['take my own life', 'suicide_risk'],
    ['end my life', 'suicide_risk'],
    // English — self-harm
    ['I cut myself', 'self_harm'],
    ['I hurt myself', 'self_harm'],
    ['self-harm', 'self_harm'],
  ])('flags "%s" as %s', (text, expectedCategory) => {
    const result = classifier.classify(text);
    expect(result.isCrisis).toBe(true);
    expect(result.category).toBe(expectedCategory);
  });

  // ── Must NOT flag ──────────────────────────────────────────────────────────

  it.each([
    'hola, ¿cómo estás?',
    'soñé que volaba muy alto',
    'tuve un sueño raro con agua',
    'me siento triste hoy',
    'estoy muy enojado',
    'esto me está matando de risa',       // figurative
    'me está matando el calor',           // figurative
    'me muero de ganas de comer',         // figurative
    'this is killing me (work stress)',   // figurative, English
    '¿qué significa soñar con serpientes?',
  ])('does not flag normal message: "%s"', (text) => {
    const result = classifier.classify(text);
    expect(result.isCrisis).toBe(false);
  });

  // ── Category assignment ────────────────────────────────────────────────────

  it('returns isCrisis: false and no category for safe text', () => {
    const result = classifier.classify('buenos días');
    expect(result).toEqual({ isCrisis: false });
  });
});

describe('SafetyClassifier — async (no platform key)', () => {
  const classifier = new SafetyClassifier();

  afterEach(() => {
    delete process.env.SAFETY_PROVIDER_API_KEY;
  });

  it('falls back to keyword rules when SAFETY_PROVIDER_API_KEY is not set', async () => {
    delete process.env.SAFETY_PROVIDER_API_KEY;
    const result = await classifier.classifyAsync('quiero suicidarme');
    expect(result.isCrisis).toBe(true);
  });

  it('returns false for safe text with no platform key', async () => {
    delete process.env.SAFETY_PROVIDER_API_KEY;
    const result = await classifier.classifyAsync('hola mundo');
    expect(result.isCrisis).toBe(false);
  });
});

describe('SafetyClassifier — async with LLM classifier', () => {
  it('uses LLM result when keyword check passes and platform key is set', async () => {
    process.env.SAFETY_PROVIDER_API_KEY = 'fake-platform-key';

    const classifier = new SafetyClassifier();

    // Stub Anthropic to return a crisis signal for an ambiguous message
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"isCrisis":true,"category":"suicide_risk"}' }],
    });
    // Inject mock into the private client — also set llmClientKey so the key-rotation guard
    // doesn't replace the injected mock with a real Anthropic instance
    type ClassifierPrivate = { llmClient: { messages: { create: typeof mockCreate } }; llmClientKey: string };
    (classifier as unknown as ClassifierPrivate).llmClient = { messages: { create: mockCreate } };
    (classifier as unknown as ClassifierPrivate).llmClientKey = 'fake-platform-key';

    const result = await classifier.classifyAsync('text that passes keyword rules but is ambiguous');
    expect(result.isCrisis).toBe(true);
    expect(result.category).toBe('suicide_risk');
    expect(mockCreate).toHaveBeenCalledOnce();

    delete process.env.SAFETY_PROVIDER_API_KEY;
  });

  it('falls back to keyword result if LLM classifier throws', async () => {
    process.env.SAFETY_PROVIDER_API_KEY = 'fake-platform-key';

    const classifier = new SafetyClassifier();
    type ClassifierPrivate = { llmClient: { messages: { create: () => never } }; llmClientKey: string };
    (classifier as unknown as ClassifierPrivate).llmClient = { messages: { create: () => { throw new Error('network error'); } } };
    (classifier as unknown as ClassifierPrivate).llmClientKey = 'fake-platform-key';

    const result = await classifier.classifyAsync('ordinary message');
    expect(result.isCrisis).toBe(false); // keyword result, not an error

    delete process.env.SAFETY_PROVIDER_API_KEY;
  });
});
