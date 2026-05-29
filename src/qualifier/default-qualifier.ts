import {
  bloomLevel,
  bloomNeedsCoordinator,
  hasMultiStepLanguage,
  hasReasoningRequest,
  hasToolInvocationKeyword,
  subQuestionCount,
  tokenCount,
  TOKEN_LOW,
} from './signals.js';
import type { Qualifier, QualificationInput, QualificationResult } from './types.js';

/**
 * v1 rule-based qualifier (#167). Decision tree, ordered so the
 * highest-signal gate (tool-invocation keywords) wins first. The default for
 * ambiguous middle-band asks is `'normal'` — mirroring FrugalGPT's
 * "try the cheap path first" cascade rather than RouteLLM's preference
 * threshold (which we can't train without telemetry yet).
 *
 * The chosen `reason` is a kebab-case code naming the strongest signal so
 * `debugLog('policy:decide', …)` is greppable.
 */
export class DefaultQualifier implements Qualifier {
  qualify(input: QualificationInput): QualificationResult {
    const text = input.userText ?? '';
    const tokens = tokenCount(text);
    const toolKw = hasToolInvocationKeyword(text);
    const multiStep = hasMultiStepLanguage(text);
    const questions = subQuestionCount(text);
    const reasoning = hasReasoningRequest(text);
    const bloom = bloomLevel(text);
    const bloomEscalates = bloomNeedsCoordinator(bloom);

    const signals: Record<string, boolean | number | string> = {
      tokens,
      toolKw,
      multiStep,
      questions,
      reasoning,
      bloom,
    };

    // Escalation gates — any one hit promotes the turn to react. Ordered
    // so the strongest / most distinctive signal names the reason.
    if (multiStep) {
      return { strategyId: 'react', reason: 'qualifier:multi-step-language', signals };
    }
    if (toolKw && (bloomEscalates || tokens > TOKEN_LOW)) {
      // Pure tool-keyword on a short ask ("run ls") doesn't need coordinator;
      // require either Apply/Analyze/Evaluate framing or non-trivial length.
      return { strategyId: 'react', reason: 'qualifier:tool-keyword-and-complexity', signals };
    }
    if (questions >= 2) {
      return { strategyId: 'react', reason: 'qualifier:multiple-questions', signals };
    }
    if (bloomEscalates) {
      return { strategyId: 'react', reason: `qualifier:bloom-${bloom}`, signals };
    }

    // Safe-light path: short, no tool keywords, no reasoning request, ≤1 question.
    if (tokens < TOKEN_LOW && !toolKw && !reasoning && questions <= 1) {
      return { strategyId: 'normal', reason: 'qualifier:short-and-simple', signals };
    }

    // Middle band — default to normal per FrugalGPT cascade design.
    return { strategyId: 'normal', reason: 'qualifier:default-light', signals };
  }
}
