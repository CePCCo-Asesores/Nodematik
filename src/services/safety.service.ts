import type { ClassificationResult } from '../types';

// Platform-controlled safety classifier — deliberately independent of whatever
// LLM a client chose for their bot. A weak or uncensored client model cannot
// degrade the safety layer.

// Crisis keyword patterns (Spanish + English, Mexico defaults)
const CRISIS_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(suicid[oaie]|suicidarme|suicidarle|suicidarlos?)\b/i, category: 'suicide_risk' },
  { pattern: /\bmatarme\b|\bme\s+quiero\s+matar\b|\bme\s+voy\s+a\s+matar\b/i, category: 'suicide_risk' },
  { pattern: /\bquiero\s+(morir|morirme)\b|\bdeseo\s+(morir|morirme)\b|\bme\s+quiero\s+morir\b/i, category: 'suicide_risk' },
  { pattern: /\bquitarme\s+la\s+vida\b|\bacabar\s+con\s+mi\s+vida\b|\bfin\s+a\s+mi\s+vida\b/i, category: 'suicide_risk' },
  { pattern: /\bhacerme\s+da[ñn]o\b|\blastimarme\b|\bcortarme\s+las?\s+venas?\b/i, category: 'self_harm' },
  { pattern: /\bno\s+quiero\s+(seguir\s+)?vivir\b|\bya\s+no\s+quiero\s+vivir\b/i, category: 'suicide_risk' },
  { pattern: /\bpastillas?\s+para\s+(morir|matarme|suicidarme)\b/i, category: 'suicide_risk' },
  // English
  { pattern: /\b(kill\s+myself|killing\s+myself|end\s+my\s+life|take\s+my\s+(own\s+)?life)\b/i, category: 'suicide_risk' },
  { pattern: /\b(want\s+to\s+die|wanna\s+die|going\s+to\s+kill\s+myself)\b/i, category: 'suicide_risk' },
  { pattern: /\b(cut\s+myself|hurt\s+myself|self(-|\s)harm)\b/i, category: 'self_harm' },
];

export class SafetyClassifier {
  classify(text: string): ClassificationResult {
    for (const { pattern, category } of CRISIS_PATTERNS) {
      if (pattern.test(text)) {
        return { isCrisis: true, category };
      }
    }
    return { isCrisis: false };
  }
}

export const safetyClassifier = new SafetyClassifier();
